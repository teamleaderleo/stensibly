import { ESLintUtils } from "@typescript-eslint/utils";
import * as ts from "typescript";

const createRule = ESLintUtils.RuleCreator.withoutDocs;

function unionParts(type) {
  return type.isUnion() ? type.types : [type];
}

function hasOwningReceiverPart(type) {
  return unionParts(type).some(part => {
    const ignored =
      ts.TypeFlags.Any |
      ts.TypeFlags.Unknown |
      ts.TypeFlags.Never |
      ts.TypeFlags.Void |
      ts.TypeFlags.Undefined |
      ts.TypeFlags.Null;
    return (part.flags & ignored) === 0;
  });
}

function receiverType(checker, signature, location) {
  return signature.thisParameter
    ? checker.getTypeOfSymbolAtLocation(signature.thisParameter, location)
    : undefined;
}

function isReceiverAware(checker, type, location) {
  return type.getCallSignatures().some(signature => {
    const receiver = receiverType(checker, signature, location);
    return receiver !== undefined && hasOwningReceiverPart(receiver);
  });
}

function contextualTypeErasesReceiver(checker, contextualType, location) {
  const signatures = contextualType.getCallSignatures();
  return signatures.length > 0 && signatures.every(signature => {
    const receiver = receiverType(checker, signature, location);
    return receiver === undefined || !hasOwningReceiverPart(receiver);
  });
}

export default createRule({
  name: "no-receiver-erasure",
  meta: {
    type: "problem",
    docs: {
      description: "Disallow contextual widening that erases a receiver-sensitive host function's owning receiver",
    },
    schema: [],
    messages: {
      erased: "This assignment erases a receiver-sensitive function's owning receiver. Wrap or bind the host function before storing it as a plain callback.",
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    return {
      Identifier(node) {
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        if (!ts.isExpression(tsNode)) return;

        const sourceType = checker.getTypeAtLocation(tsNode);
        if (!isReceiverAware(checker, sourceType, tsNode)) return;

        const contextualType = checker.getContextualType(tsNode);
        if (!contextualType) return;
        if (!contextualTypeErasesReceiver(checker, contextualType, tsNode)) return;

        context.report({ node, messageId: "erased" });
      },
    };
  },
});
