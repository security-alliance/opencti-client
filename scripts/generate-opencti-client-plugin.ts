import fs from "node:fs";
import path from "node:path";
import { PluginFunction } from "@graphql-codegen/plugin-helpers";
import * as TypeScriptPlugin from "@graphql-codegen/typescript";
import * as Common from "@graphql-codegen/visitor-plugin-common";
import { Kind, parse, visit } from "graphql";
import { OperationProcessor, OpNodeJSON } from "./operation-processor";
import { TypeProcessor } from "./type-processor";

type Config = Common.RawConfig & TypeScriptPlugin.TypeScriptPluginConfig & { jsonOutputDir?: string };

const plugin: PluginFunction<Config> = (schema, documents, config) => {
    const visitor = new TypeScriptPlugin.TsVisitor(schema, config);

    const operationProcessor = new OperationProcessor(visitor);
    const typeProcessor = new TypeProcessor(visitor);

    for (const type of Object.values(schema.getTypeMap())) {
        typeProcessor.processType(type);
    }

    for (const type of Object.values(schema.getTypeMap())) {
        typeProcessor.generateFragmentForType(type);
    }

    const queryType = schema.getQueryType();
    if (queryType) {
        for (const field of Object.values(queryType.getFields())) {
            operationProcessor.generateClientFunction("Query", [field]);
        }
    }

    const mutationType = schema.getMutationType();
    if (mutationType) {
        for (const field of Object.values(mutationType.getFields())) {
            operationProcessor.generateClientFunction("Mutation", [field]);
        }
    }

    // Parse all documents once, classify as fragment or document, and compute dependencies
    const allDocuments = { ...typeProcessor.gqlDocuments, ...operationProcessor.gqlDocuments };
    const fragmentEntries: Record<string, string> = {};
    const documentEntries: Record<string, [string, string[]]> = {};
    const isFragment = new Set<string>();
    const directDeps = new Map<string, Set<string>>();

    for (const [name, val] of Object.entries(allDocuments)) {
        const parsed = parse(val);
        if (parsed.definitions[0].kind === Kind.FRAGMENT_DEFINITION) {
            fragmentEntries[name] = val;
            isFragment.add(name);
        }
        const deps = new Set<string>();
        visit(parsed, {
            FragmentSpread(frag) {
                deps.add(frag.name.value);
            },
        });
        directDeps.set(name, deps);
    }

    // Resolve transitive dependencies (topological order)
    const resolvedDeps = new Map<string, string[]>();
    const pending = Array.from(directDeps.keys());
    while (pending.length > 0) {
        const next = pending.shift()!;
        const deps = directDeps.get(next)!;
        if ([...deps].every((dep) => resolvedDeps.has(dep))) {
            resolvedDeps.set(
                next,
                Array.from(new Set([...deps, ...Array.from(deps).flatMap((dep) => resolvedDeps.get(dep)!)])),
            );
        } else {
            pending.push(next);
        }
    }

    for (const [name, val] of Object.entries(allDocuments)) {
        if (!isFragment.has(name)) {
            documentEntries[name] = [val, resolvedDeps.get(name)!];
        }
    }

    // Generate operations JSON
    const operationsJSON = operationProcessor.generateOperationsJSON();

    // Generate chainable interfaces
    const chainableInterfaces = operationProcessor.generateChainableInterfaces();

    // Build strings.bin and inline document indices into operations tree
    const fragmentIds = new Map<string, number>();
    const fragmentIndex: [number, number][] = [];
    const documentLookup = new Map<string, [number, number, number[]]>();
    let offset = 0;
    const chunks: string[] = [];

    for (const [name, val] of Object.entries(fragmentEntries)) {
        const buf = Buffer.byteLength(val, "utf-8");
        fragmentIds.set(name, fragmentIndex.length);
        fragmentIndex.push([offset, buf]);
        chunks.push(val);
        offset += buf;
    }

    for (const [name, [val, deps]] of Object.entries(documentEntries)) {
        const buf = Buffer.byteLength(val, "utf-8");
        documentLookup.set(name, [offset, buf, deps.map((d) => fragmentIds.get(d)!)]);
        chunks.push(val);
        offset += buf;
    }

    // Inline doc indices into operation nodes
    type MetaOpNode = { d?: [number, number]; f?: number[]; n?: string; c?: Record<string, MetaOpNode> };
    function inlineOps(node: (typeof operationsJSON)[string]): MetaOpNode {
        const result: MetaOpNode = {};
        if (node.doc) {
            const entry = documentLookup.get(node.doc)!;
            result.d = [entry[0], entry[1]];
            if (entry[2].length > 0) result.f = entry[2];
        }
        if (node.name) result.n = node.name;
        if (node.children && Object.keys(node.children).length > 0) {
            result.c = {};
            for (const [k, v] of Object.entries(node.children)) {
                result.c[k] = inlineOps(v);
            }
        }
        return result;
    }

    const metadata: { f: [number, number][]; o: Record<string, MetaOpNode> } = {
        f: fragmentIndex,
        o: {},
    };
    for (const [k, v] of Object.entries(operationsJSON)) {
        metadata.o[k] = inlineOps(v);
    }

    // Write output files
    const outputDir = config.jsonOutputDir || path.join(process.cwd(), "src", "generated");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "metadata.json"), JSON.stringify(metadata));
    fs.writeFileSync(path.join(outputDir, "strings.bin"), chunks.join(""));

    return {
        prepend: [
            `import { openSync, readFileSync, readSync } from "node:fs";`,
            `import { fileURLToPath } from "node:url";`,
            `import { dirname, join } from "node:path";`,
        ],
        content: `${typeProcessor.tsDeclarations.join("\n\n")}

${chainableInterfaces.join("\n\n")}

type OpNode = { d?: [number, number]; f?: number[]; n?: string; c?: Record<string, OpNode> };

const __dir = dirname(fileURLToPath(import.meta.url));
const metadata: { f: [number, number][]; o: Record<string, OpNode> } = JSON.parse(readFileSync(join(__dir, "metadata.json"), "utf-8"));
const stringsFd = openSync(join(__dir, "strings.bin"), "r");

function readString(offset: number, length: number): string {
    const buf = Buffer.alloc(length);
    readSync(stringsFd, buf, 0, length, offset);
    return buf.toString("utf-8");
}

export class BaseOpenCTIClient {
    protected host: string;
    protected apiKey: string;

    private endpoint: string;
    private resolvedDocuments = new Map<number, string>();

    constructor(host: string, apiKey: string) {
        const url = new URL("/graphql", host);
        this.host = url.origin;
        this.apiKey = apiKey;
        this.endpoint = url.toString();

        return new Proxy(this, {
            get(target, prop, receiver) {
                if (typeof prop === "string" && prop in metadata.o) {
                    const meta = metadata.o[prop];
                    const field = meta.n ?? prop;
                    return (args?: any) => target._chainable(meta, [field], target._mapVars(field, args));
                }
                return Reflect.get(target, prop, receiver);
            },
        });
    }

    private _mapVars(prefix: string, args?: any): Record<string, any> {
        const vars: Record<string, any> = {};
        if (args) {
            for (const [key, value] of Object.entries(args)) {
                vars[prefix + "_" + key] = value;
            }
        }
        return vars;
    }

    private _chainable(meta: OpNode, path: string[], vars: Record<string, any>): any {
        const self = this;

        if (!meta.c && meta.d) {
            return {
                then(resolve: any, reject: any) {
                    return self._exec(meta, path, vars).then(resolve, reject);
                },
            };
        }

        return new Proxy(
            {
                then: meta.d
                    ? (resolve: any, reject: any) => self._exec(meta, path, vars).then(resolve, reject)
                    : undefined,
            },
            {
                get(target, prop) {
                    if (prop === "then") return target.then;
                    if (typeof prop === "string" && meta.c && prop in meta.c) {
                        const child = meta.c[prop];
                        return (childArgs?: any) => {
                            return self._chainable(child, [...path, prop], { ...vars, ...self._mapVars(prop, childArgs) });
                        };
                    }
                    return Reflect.get(target, prop);
                },
            },
        );
    }

    private async _exec(meta: OpNode, path: string[], vars: Record<string, any>) {
        const query = this.getResolvedDocument(meta);
        const extracted = this._extractFiles(vars);

        let res: Response;
        if (extracted) {
            const formData = new FormData();
            formData.append("operations", JSON.stringify({ query, variables: extracted.vars }));
            const map: Record<string, string[]> = {};
            let idx = 0;
            for (const filePath of extracted.files.keys()) {
                map[String(idx)] = [filePath];
                idx++;
            }
            formData.append("map", JSON.stringify(map));
            idx = 0;
            for (const file of extracted.files.values()) {
                formData.append(String(idx), file, (file as any).name ?? \`file\${idx}\`);
                idx++;
            }
            res = await fetch(this.endpoint, {
                method: "POST",
                headers: { authorization: \`Bearer \${this.apiKey}\` },
                body: formData,
            });
        } else {
            res = await fetch(this.endpoint, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: \`Bearer \${this.apiKey}\`,
                },
                body: JSON.stringify({ query, variables: vars }),
            });
        }

        const json = await res.json() as any;
        if (json.errors?.length) {
            throw new Error(json.errors.map((e: any) => e.message).join("\\n"));
        }
        let data: any = json.data;
        for (const k of path) data = data[k];
        return data;
    }

    private getResolvedDocument(meta: OpNode): string {
        const [offset, length] = meta.d!;
        let resolved = this.resolvedDocuments.get(offset);
        if (!resolved) {
            const parts = [readString(offset, length)];
            if (meta.f) {
                for (const id of meta.f) {
                    const [fOff, fLen] = metadata.f[id];
                    parts.push(readString(fOff, fLen));
                }
            }
            resolved = parts.join("\\n");
            this.resolvedDocuments.set(offset, resolved);
        }
        return resolved;
    }

    private _extractFiles(variables: Record<string, any>): { vars: Record<string, any>; files: Map<string, Blob> } | null {
        const files = new Map<string, Blob>();
        const vars = this._walkExtract(variables, "variables", files);
        return files.size > 0 ? { vars, files } : null;
    }

    private _walkExtract(obj: any, path: string, files: Map<string, Blob>): any {
        if (obj instanceof Blob) {
            files.set(path, obj);
            return null;
        }
        if (obj === null || obj === undefined || typeof obj !== "object") {
            return obj;
        }
        if (Array.isArray(obj)) {
            return obj.map((item, i) => this._walkExtract(item, \`\${path}.\${i}\`, files));
        }
        const result: Record<string, any> = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = this._walkExtract(value, \`\${path}.\${key}\`, files);
        }
        return result;
    }
}
`,
    };
};

export { plugin };
