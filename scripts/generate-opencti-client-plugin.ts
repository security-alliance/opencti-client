import { PluginFunction } from "@graphql-codegen/plugin-helpers";
import * as TypeScriptPlugin from "@graphql-codegen/typescript";
import * as Common from "@graphql-codegen/visitor-plugin-common";
import { Kind, parse, print, visit } from "graphql";
import { OperationProcessor } from "./operation-processor";
import { TypeProcessor } from "./type-processor";

type Config = Common.RawConfig & TypeScriptPlugin.TypeScriptPluginConfig;

const plugin: PluginFunction<Config> = (schema, documents, config) => {
    const formatGraphql = (raw: string) => {
        try {
            return print(parse(raw));
        } catch (e) {
            throw raw;
        }
    };

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

    const dependencies = new Map<string, string[]>();

    const allDocuments = { ...typeProcessor.gqlDocuments, ...operationProcessor.gqlDocuments };
    const pending = Array.from(Object.keys(allDocuments));
    while (true) {
        const next = pending.shift();
        if (next === undefined) break;

        const parsed = parse(allDocuments[next]);
        const deps = new Set<string>();
        visit(parsed, {
            FragmentSpread(frag) {
                deps.add(frag.name.value);
            },
        });

        const valid = Array.from(deps).filter((dep) => !dependencies.has(dep)).length == 0;
        if (!valid) {
            pending.push(next);
            continue;
        }

        dependencies.set(
            next,
            Array.from(new Set([...deps, ...Array.from(deps).flatMap((dep) => dependencies.get(dep)!)])),
        );
    }

    return {
        prepend: [
            `import { createFragmentRegistry, FragmentRegistryAPI } from "@apollo/client/cache/index.js";`,
            `import { ApolloClient, DocumentNode, InMemoryCache, gql } from '@apollo/client/core/index.js';`,
            `import UploadHttpLink from "apollo-upload-client/UploadHttpLink.mjs";`,
        ],
        content: `${typeProcessor.tsDeclarations.join("\n\n")}

const fragments: Record<string, string> = {
${Object.entries(allDocuments)
    .filter((v) => parse(v[1]).definitions[0].kind === Kind.FRAGMENT_DEFINITION)
    .map(([name, val]) => `    ${name}: \`${val}\`,`)
    .join("\n")}
};

const documents: Record<string, [string, string[]]> = {
${Object.entries(allDocuments)
    .filter((v) => parse(v[1]).definitions[0].kind !== Kind.FRAGMENT_DEFINITION)
    .map(
        ([name, val]) =>
            `    ${name}: [\`${val}\`, [${dependencies
                .get(name)!
                .map((v) => `'${v}'`)
                .join(", ")}]],`,
    )
    .join("\n")}
};

export class BaseOpenCTIClient {
    public readonly client: ApolloClient;
    public readonly fragmentRegistry: FragmentRegistryAPI;

    protected host: string;
    protected apiKey: string;
    
    private parsedDocuments = new Map<string, DocumentNode>();

    constructor(host: string, apiKey: string) {
        const endpoint = new URL("/graphql", host);
        this.host = endpoint.hostname
        this.apiKey = apiKey;

        this.fragmentRegistry = createFragmentRegistry();

        this.client = new ApolloClient({
            link: new UploadHttpLink({
                uri: endpoint.toString(),
                headers: {
                    authorization: \`Bearer \${apiKey}\`,
                },
            }),
            cache: new InMemoryCache({
                fragments: this.fragmentRegistry,
            }),
            defaultOptions: {
                query: { fetchPolicy: "no-cache" },
                mutate: { fetchPolicy: "no-cache" },
            },
        })
    }

    private getParsedDocument([query, fragmentNames]: [string, string[]]): DocumentNode {
        if (!this.parsedDocuments.has(query)) {
            this.parsedDocuments.set(query, gql(query));
            for (const fragmentName of fragmentNames) {
                if (this.fragmentRegistry.lookup(fragmentName) === null) {
                    this.fragmentRegistry.register(gql(fragments[fragmentName]))
                }
            }
        }
        
        return this.parsedDocuments.get(query)!;
    }

${Object.values(operationProcessor.clientFunctions).join("\n\n")}
}
`,
    };
};

export { plugin };
