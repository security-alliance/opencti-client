import { getBaseType } from "@graphql-codegen/plugin-helpers";
import * as TypescriptPlugin from "@graphql-codegen/typescript";
import {
    GraphQLCompositeType,
    GraphQLField,
    GraphQLInterfaceType,
    GraphQLNamedType,
    GraphQLObjectType,
    GraphQLType,
    isCompositeType,
    isEnumType,
    isEqualType,
    isInputObjectType,
    isLeafType,
    isListType,
    isNonNullType,
    isObjectType,
    isScalarType,
    isUnionType,
    TypeNameMetaFieldDef,
} from "graphql";

type ProcessedType = {
    leafFields: GraphQLField<any, any>[];
    compositeFields: GraphQLField<any, any>[];
    overriddenFields: Map<string, Set<string>>;
};

const getConnectionNodeType = (type: GraphQLType) => {
    if (!isObjectType(type)) return undefined;

    const fields = type.getFields();

    const pageInfo = fields["pageInfo"];
    const edges = fields["edges"];
    if (!pageInfo || !edges) return undefined;

    const pageInfoType = getBaseType(pageInfo.type);
    if (!isObjectType(pageInfoType) || pageInfoType.name !== "PageInfo") return undefined;

    return getEdgeNodeType(getBaseType(edges.type));
};

const getEdgeNodeType = (type: GraphQLType) => {
    if (!isObjectType(type)) return undefined;

    const fields = type.getFields();

    const cursor = fields["cursor"];
    const node = fields["node"];

    if (!cursor || !node) return undefined;

    if (getBaseType(cursor.type).name !== "String") return undefined;

    return getBaseType(node.type);
};

const isEqualField = (a: GraphQLField<any, any>, b: GraphQLField<any, any>) => {
    if (a.name !== b.name) return false;
    if (!isEqualType(a.type, b.type)) return false;

    const args1 = new Map(a.args.map((v) => [v.name, v]));
    const args2 = new Map(b.args.map((v) => [v.name, v]));

    if (args1.size !== args2.size) return false;

    for (const name of args1.keys()) {
        const arg1 = args1.get(name);
        const arg2 = args2.get(name);
        if (!arg1 || !arg2 || !isEqualType(arg1.type, arg2.type)) return false;
    }

    return true;
};

export const wrapTypeScriptType = (type: GraphQLType, baseType: string, nullable = true): string => {
    if (isNonNullType(type)) {
        return wrapTypeScriptType(type.ofType, baseType, false);
    }
    if (isListType(type)) {
        return `Array<${wrapTypeScriptType(type.ofType, baseType)}>`;
    }

    return nullable ? `Maybe<${baseType}>` : baseType;
};

export const shouldIgnoreField = (owner: GraphQLCompositeType, field: GraphQLField<any, any>) => {
    return (
        // don't return anything that requires user input automatically
        field.args.length > 0 ||
        // don't return these fields because they are computed
        field.name === "toStix" ||
        field.name === "toStixReportBundle" ||
        // these are broken?
        field.name === "spec_version" ||
        field.name === "objectAssignee" ||
        field.name === "running" ||
        (owner.name === "Capability" && (field.name === "created_at" || field.name === "updated_at")) ||
        (owner.name === "Notifier" && field.name === "notifier_configuration") ||
        (owner.name === "File" && field.name === "entity_type")
    );
};

const findCommonFields = (types: readonly GraphQLObjectType[]) => {
    const commonFields: GraphQLField<any, any>[] = [];

    const [firstType, ...otherTypes] = types;
    outer: for (const [fieldName, field] of Object.entries(firstType.getFields())) {
        for (const otherType of otherTypes) {
            const otherField = otherType.getFields()[fieldName];
            if (!otherField) continue outer;
            if (!isEqualField(field, otherField)) continue outer;
        }

        commonFields.push(field);
    }

    return commonFields;
};

export class TypeProcessor {
    private visitor: TypescriptPlugin.TsVisitor;

    private processedTypes = new Map<string, ProcessedType>();

    public gqlDocuments: Record<string, string> = {};
    public tsDeclarations: string[] = [];

    constructor(visitor: TypescriptPlugin.TsVisitor) {
        this.visitor = visitor;
    }

    private generateSelectionForType(
        type: GraphQLNamedType,
        overriddenFields: Map<string, Set<string>>,
        depth: number = 0,
        maxDepth: number = 2,
    ) {
        if (isInputObjectType(type)) return;

        if (isScalarType(type)) {
            return {
                gql: ``,
                ts: `Scalars["${type.name}"]["output"]`,
            };
        }
        if (isEnumType(type)) {
            return {
                gql: ``,
                ts: this.visitor.convertName(type.name),
            };
        }

        if (depth >= maxDepth) return; // no more recursion for objects

        if (isUnionType(type)) {
            const commonFields = findCommonFields(type.getTypes());
            const selection = this.generateSelectionForFields(commonFields, overriddenFields, depth + 1, maxDepth);
            return {
                gql: `{ ${type.getTypes().map((type) => {
                    return `... on ${type.name} { ${selection.gql.join(" ")} }`;
                })} }`,
                ts: `{ ${selection.ts.join("; ")} }`,
            };
        }

        return this.generateSelectionForObject(type, overriddenFields, depth, maxDepth);
    }

    private generateSelectionForObject(
        objectType: GraphQLObjectType | GraphQLInterfaceType,
        overriddenFieldsMap: Map<string, Set<string>>,
        depth: number,
        maxDepth: number,
    ) {
        depth++;

        const processedType = this.processedTypes.get(objectType.name);
        if (processedType === undefined) throw new Error("expected to have processed " + objectType.name);

        const gqlResult: string[] = [];
        const tsResult: string[] = [];

        const wantFields = processedType.leafFields;
        const overriddenFields = overriddenFieldsMap.get(objectType.name);
        const filteredFields = wantFields.filter((v) => !overriddenFields?.has(v.name));
        if (wantFields.length === filteredFields.length) {
            // simple case - no fields are overridden so we can select all of them
            gqlResult.push(`... ${this.visitor.convertName(objectType.name)}_Simple`);
            tsResult.push(`${this.visitor.convertName(objectType.name)}_Simple`);
        } else {
            // one or more fields was overridden by the final type, so we need to omit it here
            gqlResult.push(`... on ${objectType.name} { ${filteredFields.map((v) => v.name).join(" ")} }`);
            tsResult.push(
                `Omit<${this.visitor.convertName(objectType.name)}_Simple, ${Array.from(overriddenFields!)
                    .map((v) => `"${v}"`)
                    .join(" | ")}>`,
            );
        }

        // we can't use processedType.compositeFields here because we want *all* composite fields up the inheritance tree
        const compositeFields = Object.values(objectType.getFields()).filter(
            (field) => isCompositeType(getBaseType(field.type)) && !shouldIgnoreField(objectType, field),
        );

        if (compositeFields.length > 0) {
            const selection = this.generateSelectionForFields(compositeFields, overriddenFieldsMap, depth, maxDepth);
            if (selection.gql.length > 0) {
                gqlResult.push(...selection.gql);
                tsResult.push(`{ ${selection.ts.join("; ")} }`);
            }
        }

        return {
            gql: `{ ${gqlResult.join(" ")} }`,
            ts: tsResult.join(" & "),
        };
    }

    private generateSelectionForFields(
        fields: GraphQLField<any, any>[],
        overriddenFields: Map<string, Set<string>>,
        depth: number,
        maxDepth: number,
    ) {
        const gqlFields: string[] = [];
        const tsFields: string[] = [];

        for (const field of fields) {
            const baseReturnType = getBaseType(field.type);

            const selections = this.generateSelectionForType(baseReturnType, overriddenFields, depth, maxDepth);
            if (selections === undefined) continue;

            gqlFields.push(`${field.name} ${selections.gql}`);
            tsFields.push(`${field.name}: ${wrapTypeScriptType(field.type, selections.ts)}`);
        }

        return {
            gql: gqlFields,
            ts: tsFields,
        };
    }

    private hack_shouldLiftField(owner: GraphQLCompositeType, field: GraphQLField<any, any>) {
        return owner.name === "Connector" && field.name === "id";
    }

    public processType(type: GraphQLNamedType) {
        // skip composite or union types (the underlying types will be processed directly)
        if (!isCompositeType(type) || isUnionType(type)) return;

        // skip internal graphql types
        if (type.name.startsWith("__")) return;

        // skip root types
        if (type.name === "Query" || type.name === "Mutation" || type.name === "Subscription") return;

        // manually register the __typename field
        type.getFields()[TypeNameMetaFieldDef.name] = TypeNameMetaFieldDef;

        const result: ProcessedType = {
            leafFields: [],
            compositeFields: [],
            overriddenFields: new Map(),
        };
        this.processedTypes.set(type.name, result);

        const allBaseFields = new Map<string, [GraphQLInterfaceType, GraphQLField<any, any>][]>();

        // collect all field declarations in interfaces
        // this is safe because graphql mandates that all transitive interfaces are explicitly declared
        for (const iface of type.getInterfaces()) {
            for (const [fieldName, field] of Object.entries(iface.getFields())) {
                let arr = allBaseFields.get(fieldName);
                if (arr === undefined) allBaseFields.set(fieldName, (arr = []));
                arr.push([iface, field]);
            }
        }

        // categorize each field
        for (const [fieldName, field] of Object.entries(type.getFields())) {
            const shouldIgnore = shouldIgnoreField(type, field);

            const baseFields = allBaseFields.get(fieldName);
            if (baseFields !== undefined) {
                const overridden = baseFields
                    .filter(
                        ([, ifaceField]) =>
                            // field is overridden if types/args are not the same
                            !isEqualField(field, ifaceField) ||
                            // field is also overridden if we want to ignore it
                            shouldIgnore ||
                            // hack! field is also overriden if we want to lift it
                            this.hack_shouldLiftField(type, field),
                    )
                    .map(([iface]) => iface.name);

                // did not override any base fields, no need to select here
                if (overridden.length === 0) continue;

                for (const iface of overridden) {
                    let val = result.overriddenFields.get(iface);
                    if (val === undefined) result.overriddenFields.set(iface, (val = new Set<string>()));
                    val.add(fieldName);
                }
            }

            // we don't want to select it
            if (shouldIgnore) continue;

            const baseType = getBaseType(field.type);
            if (isLeafType(baseType)) {
                result.leafFields.push(field);
            } else if (isCompositeType(baseType)) {
                result.compositeFields.push(field);
            }
        }
    }

    public generateFragmentForType(type: GraphQLNamedType) {
        if (!isCompositeType(type)) return;

        const leafFrag = `${this.visitor.convertName(type.name)}_Simple`;
        const allFrag = `${this.visitor.convertName(type.name)}_All`;

        if (isUnionType(type)) {
            const commonFields = findCommonFields(type.getTypes());

            const leafSel = this.generateSelectionForFields(
                commonFields.filter((field) => isLeafType(getBaseType(field.type))),
                new Map(),
                0,
                0,
            );
            const allSel = this.generateSelectionForFields(
                commonFields.filter((field) => isCompositeType(getBaseType(field.type))),
                new Map(),
                0,
                0,
            );

            this.tsDeclarations.push(`export type ${leafFrag} = { ${leafSel.ts.join("; ")} };`);
            this.tsDeclarations.push(`export type ${allFrag} = ${leafFrag} & { ${allSel.ts.join("; ")} };`);
            return;
        }

        const result = this.processedTypes.get(type.name);
        if (result === undefined) return; // it was skipped

        // we want to fully expand the node of a connection or edge
        let bonus = 0;
        if (getConnectionNodeType(type) !== undefined) bonus = 2;
        if (getEdgeNodeType(type) !== undefined) bonus = 1;

        const dependencyTypes = type
            .getInterfaces()
            .map((v) => v.name)
            .reverse();
        const leafSel = this.generateSelectionForFields(result.leafFields, result.overriddenFields, 0, 0);
        const allSel = this.generateSelectionForFields(result.compositeFields, result.overriddenFields, 0, 2 + bonus);

        // HACK HACK HACK - opencti schema is fucked
        if (type.name === "Connector" || type.name === "Capability" || type.name === "Notifier") {
            dependencyTypes.length = 0;
        }

        const buildFinalResult = (selection: { gql: string[]; ts: string[] }, purpose: "Simple" | "All") => {
            const tsUnionParts: string[] = [];

            // put all the ts fields into one object, if any were selected
            if (selection.ts.length > 0) tsUnionParts.unshift(`{ ${selection.ts.join("; ")} }`);

            // the composite fragment should inherit everything from the leaf fragment
            if (purpose === "All") {
                selection.gql.unshift(`...${leafFrag}`);
                tsUnionParts.unshift(`${leafFrag}`);
            }

            for (const iface of dependencyTypes) {
                const processedResult = this.processedTypes.get(iface);
                if (processedResult === undefined) throw new Error();

                const allFields = [...processedResult.leafFields];
                if (purpose === "All") allFields.push(...processedResult.compositeFields);

                const overriddenFields = result.overriddenFields.get(iface);
                const filteredFields = allFields.filter((v) => !overriddenFields?.has(v.name));

                if (allFields.length === filteredFields.length) {
                    // simple case - no fields are overridden so we can select all of them
                    selection.gql.unshift(`...${this.visitor.convertName(iface)}_${purpose}`);
                    tsUnionParts.unshift(`${this.visitor.convertName(iface)}_${purpose}`);
                } else {
                    // one or more fields was overridden by the final type, so we need to omit it here
                    selection.gql.unshift(`... on ${iface} { ${filteredFields.map((v) => v.name).join(" ")} }`);
                    tsUnionParts.unshift(
                        `Omit<${this.visitor.convertName(iface)}_${purpose}, ${Array.from(overriddenFields!)
                            .map((v) => `"${v}"`)
                            .join(" | ")}>`,
                    );
                }
            }

            // types cannot be empty, so ensure the type always has something
            if (tsUnionParts.length === 0) tsUnionParts.push(`{}`);

            return {
                gql: `fragment ${this.visitor.convertName(type.name)}_${purpose} on ${type.name} { ${selection.gql.join(" ")} }`,
                ts: `export type ${this.visitor.convertName(type.name)}_${purpose} = ${tsUnionParts.join(" & ")};`,
            };
        };

        const finalLeaf = buildFinalResult(leafSel, "Simple");
        const finalAll = buildFinalResult(allSel, "All");

        this.gqlDocuments[leafFrag] = finalLeaf.gql;
        this.gqlDocuments[allFrag] = finalAll.gql;
        this.tsDeclarations.push(finalLeaf.ts);
        this.tsDeclarations.push(finalAll.ts);
    }
}
