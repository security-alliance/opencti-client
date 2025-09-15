import { PluginFunction } from "@graphql-codegen/plugin-helpers";
import * as TypeScriptPlugin from "@graphql-codegen/typescript";
import * as Common from "@graphql-codegen/visitor-plugin-common";
import { Kind, parse, print } from "graphql";
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

    return {
        prepend: [
            `import { ApolloClient, NormalizedCacheObject, InMemoryCache, gql } from '@apollo/client/core/index.js';`,
            `import { createFragmentRegistry } from "@apollo/client/cache/inmemory/fragmentRegistry.js";`,
            `import createUploadLink from "apollo-upload-client/createUploadLink.mjs";`,
        ],
        content: `${Object.entries({ ...typeProcessor.gqlDocuments, ...operationProcessor.gqlDocuments })
            .map(([name, val]) => `export const ${name} = gql\`${formatGraphql(val)}\``)
            .join("\n\n")}

${typeProcessor.tsDeclarations.join("\n\n")}

export const ALL_FRAGMENTS = [${Object.values({ ...typeProcessor.gqlDocuments, ...operationProcessor.gqlDocuments })
            .map((v) => parse(v))
            .flatMap((v) => v.definitions)
            .filter((v) => v.kind === Kind.FRAGMENT_DEFINITION)
            .map((v) => v.name.value)
            .join(", ")}];

export class BaseOpenCTIClient {
    public readonly client: ApolloClient<NormalizedCacheObject>;

    protected host: string;
    protected apiKey: string;

    constructor(host: string, apiKey: string) {
        const endpoint = new URL("/graphql", host);
        this.host = endpoint.hostname
        this.apiKey = apiKey;

        this.client = new ApolloClient({
            link: createUploadLink({
                uri: endpoint.toString(),
                headers: {
                    authorization: \`Bearer \${apiKey}\`,
                },
            }),
            cache: new InMemoryCache({
                fragments: createFragmentRegistry(...ALL_FRAGMENTS),
            }),
            defaultOptions: {
                query: { fetchPolicy: "no-cache" },
                mutate: { fetchPolicy: "no-cache" },
            },
        })
    }

${Object.values(operationProcessor.clientFunctions).join("\n\n")}
}
`,
    };
};

export { plugin };
