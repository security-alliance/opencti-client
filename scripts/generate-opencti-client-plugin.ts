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

    // Build strings.bin (concatenated raw GQL bytes) and fragments.bin (fragment ID → offset+length)
    const stringChunks: Buffer[] = [];
    let stringsOffset = 0;
    const fragmentIds = new Map<string, number>();
    const fragmentTable: [number, number][] = []; // fragment ID → [offset, length]
    const documentLookup = new Map<string, [[number, number], number[]]>(); // docName → [[offset, length], fragIds[]]

    // Write fragments first to assign IDs
    for (const [name, val] of Object.entries(fragmentEntries)) {
        const buf = Buffer.from(val, "utf-8");
        fragmentIds.set(name, fragmentTable.length);
        fragmentTable.push([stringsOffset, buf.length]);
        stringChunks.push(buf);
        stringsOffset += buf.length;
    }

    // Write documents
    for (const [name, [val, deps]] of Object.entries(documentEntries)) {
        const buf = Buffer.from(val, "utf-8");
        const docRef: [number, number] = [stringsOffset, buf.length];
        const fragIds = deps.map((d) => fragmentIds.get(d)!);
        documentLookup.set(name, [docRef, fragIds]);
        stringChunks.push(buf);
        stringsOffset += buf.length;
    }

    // Build binary OpNode representations
    type MetaOpNode = {
        doc?: [number, number];
        fragments?: number[];
        originalName?: string;
        children?: Record<string, MetaOpNode>;
    };
    function buildMetaNode(node: (typeof operationsJSON)[string]): MetaOpNode {
        const result: MetaOpNode = {};
        if (node.doc) {
            const entry = documentLookup.get(node.doc)!;
            result.doc = entry[0];
            if (entry[1].length > 0) result.fragments = entry[1];
        }
        if (node.name) result.originalName = node.name;
        if (node.children && Object.keys(node.children).length > 0) {
            result.children = {};
            for (const [k, v] of Object.entries(node.children)) {
                result.children[k] = buildMetaNode(v);
            }
        }
        return result;
    }

    const opNodes: Record<string, MetaOpNode> = {};
    for (const [k, v] of Object.entries(operationsJSON)) {
        opNodes[k] = buildMetaNode(v);
    }

    // Encode a single OpNode into binary
    // Flags: bit0=doc, bit1=fragments, bit2=originalName, bit3=children
    function encodeNode(node: MetaOpNode): Buffer {
        const parts: Buffer[] = [];
        let flags = 0;
        if (node.doc !== undefined) flags |= 1;
        if (node.fragments) flags |= 2;
        if (node.originalName) flags |= 4;
        if (node.children && Object.keys(node.children).length > 0) flags |= 8;
        parts.push(Buffer.from([flags]));

        if (node.doc !== undefined) {
            const buf = Buffer.alloc(8);
            buf.writeUInt32LE(node.doc[0], 0);
            buf.writeUInt32LE(node.doc[1], 4);
            parts.push(buf);
        }
        if (node.fragments) {
            const buf = Buffer.alloc(2 + node.fragments.length * 2);
            buf.writeUInt16LE(node.fragments.length, 0);
            for (let i = 0; i < node.fragments.length; i++) {
                buf.writeUInt16LE(node.fragments[i], 2 + i * 2);
            }
            parts.push(buf);
        }
        if (node.originalName) {
            const nameBytes = Buffer.from(node.originalName, "utf-8");
            parts.push(Buffer.from([nameBytes.length]));
            parts.push(nameBytes);
        }
        if (node.children && Object.keys(node.children).length > 0) {
            const entries = Object.entries(node.children);
            parts.push(Buffer.from([entries.length]));
            for (const [key, child] of entries) {
                const keyBytes = Buffer.from(key, "utf-8");
                parts.push(Buffer.from([keyBytes.length]));
                parts.push(keyBytes);
                parts.push(encodeNode(child));
            }
        }
        return Buffer.concat(parts);
    }

    // Build nodes.bin with inline index header
    // Header: [uint32 headerSize] [uint32 entryCount] [uint8 keyLen, key bytes, uint32 nodeOffset, uint32 nodeLength] × entryCount
    // Then: packed binary nodes (offsets are absolute positions in the file)
    const encodedNodes: { name: string; encoded: Buffer }[] = [];
    for (const [name, node] of Object.entries(opNodes)) {
        encodedNodes.push({ name, encoded: encodeNode(node) });
    }

    // Compute header content size (excludes the 4-byte size prefix)
    let headerContentSize = 0;
    for (const { name } of encodedNodes) {
        headerContentSize += 1 + Buffer.byteLength(name, "utf-8") + 4 + 4; // keyLen + key + offset + length
    }

    // Build header + nodes
    const nodeChunks: Buffer[] = [];
    const headerBuf = Buffer.alloc(4 + headerContentSize);
    headerBuf.writeUInt32LE(headerContentSize, 0);
    let headerPos = 4;
    let nodeOffset = 4 + headerContentSize;
    for (const { name, encoded } of encodedNodes) {
        const nameBytes = Buffer.from(name, "utf-8");
        headerBuf[headerPos++] = nameBytes.length;
        nameBytes.copy(headerBuf, headerPos);
        headerPos += nameBytes.length;
        headerBuf.writeUInt32LE(nodeOffset, headerPos);
        headerPos += 4;
        headerBuf.writeUInt32LE(encoded.length, headerPos);
        headerPos += 4;
        nodeChunks.push(encoded);
        nodeOffset += encoded.length;
    }

    // Build fragments.bin (flat array: fragment ID i → uint32LE offset, uint32LE length at i*8)
    const fragsBuf = Buffer.alloc(fragmentTable.length * 8);
    for (let i = 0; i < fragmentTable.length; i++) {
        fragsBuf.writeUInt32LE(fragmentTable[i][0], i * 8);
        fragsBuf.writeUInt32LE(fragmentTable[i][1], i * 8 + 4);
    }

    // Write output files
    const outputDir = config.jsonOutputDir || path.join(process.cwd(), "src", "generated");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "strings.bin"), Buffer.concat(stringChunks));
    fs.writeFileSync(path.join(outputDir, "fragments.bin"), fragsBuf);
    fs.writeFileSync(path.join(outputDir, "nodes.bin"), Buffer.concat([headerBuf, ...nodeChunks]));

    return {
        prepend: [
            `import { openSync, readSync } from "node:fs";`,
            `import { fileURLToPath } from "node:url";`,
            `import { dirname, join } from "node:path";`,
        ],
        content: `${typeProcessor.tsDeclarations.join("\n\n")}

${chainableInterfaces.join("\n\n")}

type OpNode = { doc?: [number, number]; fragments?: number[]; originalName?: string; children?: Record<string, OpNode> };

const __dir = dirname(fileURLToPath(import.meta.url));

const nodesFd = openSync(join(__dir, "nodes.bin"), "r");
const fragsFd = openSync(join(__dir, "fragments.bin"), "r");
const stringsFd = openSync(join(__dir, "strings.bin"), "r");

const headerSizeBuf = Buffer.alloc(4);
readSync(nodesFd, headerSizeBuf, 0, 4, 0);
const nodesHeaderSize = headerSizeBuf.readUInt32LE(0);
const nodesHeader = Buffer.alloc(nodesHeaderSize);
readSync(nodesFd, nodesHeader, 0, nodesHeaderSize, 4);
const nodesHeaderView = new DataView(nodesHeader.buffer, nodesHeader.byteOffset, nodesHeader.byteLength);

const stringCache = new Map<number, string>();

function getString(offset: number, length: number): string {
    let s = stringCache.get(offset);
    if (s !== undefined) return s;
    const buf = Buffer.alloc(length);
    readSync(stringsFd, buf, 0, length, offset);
    s = buf.toString("utf-8");
    stringCache.set(offset, s);
    return s;
}

function getFragment(id: number): string {
    const fb = Buffer.alloc(8);
    readSync(fragsFd, fb, 0, 8, id * 8);
    return getString(fb.readUInt32LE(0), fb.readUInt32LE(4));
}

function lookupNode(name: string): [number, number] | undefined {
    let pos = 0;
    while (pos < nodesHeader.length) {
        const keyLen = nodesHeader[pos];
        if (keyLen === name.length) {
            let match = true;
            for (let j = 0; j < keyLen; j++) {
                if (nodesHeader[pos + 1 + j] !== name.charCodeAt(j)) { match = false; break; }
            }
            if (match) {
                const off = nodesHeaderView.getUint32(pos + 1 + keyLen, true);
                const len = nodesHeaderView.getUint32(pos + 1 + keyLen + 4, true);
                return [off, len];
            }
        }
        pos += 1 + keyLen + 4 + 4;
    }
    return undefined;
}

const opCache = new Map<string, OpNode>();

function decodeNodeAt(buf: Buffer, pos: number): { node: OpNode; end: number } {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const flags = buf[pos++];
    const node: OpNode = {};

    if (flags & 1) {
        node.doc = [view.getUint32(pos, true), view.getUint32(pos + 4, true)];
        pos += 8;
    }
    if (flags & 2) {
        const count = view.getUint16(pos, true);
        pos += 2;
        node.fragments = [];
        for (let i = 0; i < count; i++) {
            node.fragments.push(view.getUint16(pos, true));
            pos += 2;
        }
    }
    if (flags & 4) {
        const nLen = buf[pos++];
        node.originalName = buf.toString("utf-8", pos, pos + nLen);
        pos += nLen;
    }
    if (flags & 8) {
        const childCount = buf[pos++];
        node.children = {};
        for (let i = 0; i < childCount; i++) {
            const keyLen = buf[pos++];
            const key = buf.toString("utf-8", pos, pos + keyLen);
            pos += keyLen;
            const child = decodeNodeAt(buf, pos);
            node.children[key] = child.node;
            pos = child.end;
        }
    }
    return { node, end: pos };
}

function getOperation(name: string): OpNode | undefined {
    let node = opCache.get(name);
    if (node) return node;
    const entry = lookupNode(name);
    if (!entry) return undefined;
    const buf = Buffer.alloc(entry[1]);
    readSync(nodesFd, buf, 0, entry[1], entry[0]);
    node = decodeNodeAt(buf, 0).node;
    opCache.set(name, node);
    return node;
}

export class BaseOpenCTIClient {
    protected host: string;
    protected apiKey: string;

    private endpoint: string;

    constructor(host: string, apiKey: string) {
        const url = new URL("/graphql", host);
        this.host = url.origin;
        this.apiKey = apiKey;
        this.endpoint = url.toString();

        return new Proxy(this, {
            get(target, prop, receiver) {
                if (typeof prop === "string") {
                    const meta = getOperation(prop);
                    if (meta) {
                        const field = meta.originalName ?? prop;
                        return (args?: any) => target._chainable(meta, [field], target._mapVars(field, args));
                    }
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

        if (!meta.children && meta.doc !== undefined) {
            return {
                then(resolve: any, reject: any) {
                    return self._exec(meta, path, vars).then(resolve, reject);
                },
            };
        }

        return new Proxy(
            {
                then: meta.doc !== undefined
                    ? (resolve: any, reject: any) => self._exec(meta, path, vars).then(resolve, reject)
                    : undefined,
            },
            {
                get(target, prop) {
                    if (prop === "then") return target.then;
                    if (typeof prop === "string" && meta.children && prop in meta.children) {
                        const child = meta.children[prop];
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
        const query = this._buildQuery(meta);
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

    private _buildQuery(meta: OpNode): string {
        const parts = [getString(meta.doc![0], meta.doc![1])];
        if (meta.fragments) {
            for (const id of meta.fragments) {
                parts.push(getFragment(id));
            }
        }
        return parts.join("\\n");
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
