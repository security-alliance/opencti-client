import { getBaseType } from "@graphql-codegen/plugin-helpers";
import * as TypescriptPlugin from "@graphql-codegen/typescript";
import {
    GraphQLField,
    GraphQLObjectType,
    GraphQLOutputType,
    isCompositeType,
    isEnumType,
    isObjectType,
    isScalarType,
    isUnionType,
} from "graphql";
import { shouldIgnoreField, wrapTypeScriptType } from "./type-processor";

export class OperationProcessor {
    visitor: TypescriptPlugin.TsVisitor;
    public clientFunctions: Record<string, string> = {};
    public gqlDocuments: Record<string, string> = {};

    constructor(visitor: TypescriptPlugin.TsVisitor) {
        this.visitor = visitor;
    }

    private isNestedOperation(
        rootType: "Query" | "Mutation",
        field: GraphQLField<any, any>,
    ): field is GraphQLField<any, any> & { type: GraphQLObjectType } {
        if (!isObjectType(field.type)) return false;

        if (rootType === "Mutation") return field.type.name.endsWith("Mutations");

        return true;
    }

    private generateFullSelectionForType(type: GraphQLOutputType): string {
        const baseType = getBaseType(type);

        if (isUnionType(baseType)) {
            return `{ ${baseType
                .getTypes()
                .map((type) => `... on ${type.name} ${this.generateFullSelectionForType(type)}`)
                .join(" ")} }`;
        }

        if (isCompositeType(baseType)) {
            return `{ ...${this.visitor.convertName(baseType.name)}_All }`;
        }

        return "";
    }

    private generateFieldMetadata(rootType: "Query" | "Mutation", fields: GraphQLField<any, any>[]) {
        const typescriptParamTypes = fields.map((field, idx) => {
            const hasVariables = field.args.length > 0;

            const variableName = `arg${idx}_${field.name}`;
            const typeName =
                (idx === 0 ? rootType : (fields[idx - 1].type as GraphQLObjectType<any, any>).name) +
                (this.visitor.config.addUnderscoreToArgsType ? "_" : "") +
                this.visitor.convertName(field.name, {
                    useTypesPrefix: false,
                    useTypesSuffix: false,
                }) +
                "Args";

            const valuesSpread = field.args.map((arg) => {
                return {
                    tsVariable: variableName,
                    gqlField: field.name,
                    gqlArg: arg.name,
                    gqlVariableName: `${field.name}_${arg.name}`,
                    gqlType: arg.type.toString(),
                };
            });

            const gqlBodyArgs = valuesSpread
                .map((v) => {
                    return `${v.gqlArg}: $${v.gqlVariableName}`;
                })
                .join(", ");

            let gqlBodyPrefix = `${field.name}${gqlBodyArgs ? `(${gqlBodyArgs})` : ""}`;
            let gqlBodySuffix = ``;

            if (idx !== fields.length - 1) {
                gqlBodyPrefix += ` {`;
                gqlBodySuffix += `}`;
            } else {
                gqlBodyPrefix += this.generateFullSelectionForType(field.type);
            }

            return {
                variableInfo: hasVariables
                    ? {
                          variableName,
                          typeName,
                          valuesSpread,
                      }
                    : undefined,
                gqlBodyPrefix,
                gqlBodySuffix,
            };
        });

        const hasVariables = typescriptParamTypes.map((v) => v.variableInfo).filter((v) => !!v);

        const gqlDocumentVariables = hasVariables
            .flatMap((v) => v.valuesSpread)
            .map((v) => `$${v.gqlVariableName}: ${v.gqlType}`)
            .join(", ");

        const gqlBody =
            typescriptParamTypes.map((v) => v.gqlBodyPrefix).join(" ") +
            typescriptParamTypes.map((v) => v.gqlBodySuffix).join(" ");

        return {
            requiredImports: hasVariables.map((v) => v.typeName),
            typescriptFunctionParams: hasVariables.map((v) => `${v.variableName}?: ${v.typeName}`).join(", "),
            typescriptVariablesSpread: hasVariables
                .flatMap((v) => v.valuesSpread)
                .map((v) => `${v.gqlVariableName}: ${v.tsVariable}?.${v.gqlArg}`)
                .join(", "),
            gqlDocumentVariables: gqlDocumentVariables ? `(${gqlDocumentVariables})` : "",
            gqlBody: gqlBody,
        };
    }

    public generateClientFunction(rootType: "Query" | "Mutation", fields: GraphQLField<any, any>[]) {
        const metadata = this.generateFieldMetadata(rootType, fields);

        const currentField = fields[fields.length - 1];

        if (currentField.name === "__typename") return;

        // check if we should generate functions for nested operations
        if (this.isNestedOperation(rootType, currentField)) {
            for (const childField of Object.values(currentField.type.getFields())) {
                if (rootType === "Query" && !shouldIgnoreField(currentField.type, childField)) continue;

                this.generateClientFunction(rootType, [...fields, childField]);
            }

            // we never want to generate a "select all" for mutations, because each leaf field is also a mutation
            if (rootType === "Mutation") return;
        }

        const documentName = `${rootType}${fields.map((v) => this.visitor.convertName(v.name)).join("")}`;
        let functionName = fields.map((v) => v.name).join("_");
        if (functionName in this.clientFunctions) {
            functionName += rootType;
        }

        const baseType = getBaseType(currentField.type);
        const functionReturnType = wrapTypeScriptType(
            currentField.type,
            isScalarType(baseType)
                ? `Scalars["${baseType.name}"]["output"]`
                : isEnumType(baseType)
                  ? this.visitor.convertName(baseType.name)
                  : `${this.visitor.convertName(baseType.name)}_All`,
        );

        this.clientFunctions[functionName] =
            `    async ${functionName}(${metadata.typescriptFunctionParams}): Promise<${functionReturnType}> {
        const result = await this.client.${rootType === "Query" ? "query" : "mutate"}({
            ${rootType === "Query" ? "query" : "mutation"}: this.getParsedDocument(documents['${documentName}']),
            variables: {
                ${metadata.typescriptVariablesSpread}
            },
        });

        return (result.data as any).${fields.map((v) => v.name).join(".")};
    }`;

        this.gqlDocuments[documentName] =
            `${rootType === "Query" ? "query" : "mutation"} ${metadata.gqlDocumentVariables} { ${metadata.gqlBody} }`;
    }
}
