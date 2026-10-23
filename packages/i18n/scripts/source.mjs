import ts from "typescript";

const visibleAttributes = new Set([
  "aria-label",
  "ariaLabel",
  "title",
  "label",
  "legend",
  "placeholder",
  "actionLabel",
  "allDayText",
  "noEventsText",
  "description",
  "detail",
  "body",
  "summary",
  "action",
  "recovery",
  "alt",
  "data-swipe-hint",
]);
const visibleProperties = new Set([
  "label",
  "description",
  "ariaLabel",
  "placeholder",
]);
const brands = new Set(["TaskNotes", "mdbase", "Markdown", "ICS"]);
const macros = new Set([
  "t",
  "translate",
  "msg",
  "defineMessage",
  "plural",
  "select",
  "selectOrdinal",
]);
const comparisons = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** Structural guard, not an assertion that arbitrary English in every layer is UI copy. */
export function inspectUiSource(source, file = "component.tsx", options = {}) {
  const allowedBrands = new Set([...brands, ...(options.brands ?? [])]);
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const issues = [];
  const add = (node, kind, text) =>
    issues.push({
      file,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      kind,
      text,
    });
  const tag = (node) => node.tagName?.getText(ast);
  function covered(node) {
    let expression = ts.isJsxExpression(node);
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isJsxExpression(p)) expression = true;
      if (ts.isCallExpression(p) && macros.has(p.expression.getText(ast)))
        return true;
      if (
        ts.isTaggedTemplateExpression(p) &&
        ["t", "translate"].includes(p.tag.getText(ast))
      )
        return true;
      if (
        ts.isJsxElement(p) &&
        ["Trans", "Plural", "Select", "SelectOrdinal"].includes(
          tag(p.openingElement),
        ) &&
        !expression
      )
        return true;
      if (
        ts.isJsxSelfClosingElement(p) &&
        ["Plural", "Select", "SelectOrdinal"].includes(tag(p))
      )
        return true;
    }
    return false;
  }
  const human = (text) => /[A-Za-z]/.test(text) && !allowedBrands.has(text.trim());
  const identifiers = new Set([
    "className",
    "id",
    "key",
    "href",
    "src",
    "role",
    "type",
  ]);
  function output(node) {
    let property = false;
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isBinaryExpression(p) && comparisons.has(p.operatorToken.kind))
        return false;
      if (
        ts.isConditionalExpression(p) &&
        p.condition.pos <= node.pos &&
        p.condition.end >= node.end
      )
        return false;
      if (ts.isCallExpression(p)) return false;
      if (ts.isPropertyAssignment(p))
        property = visibleProperties.has(p.name.getText(ast));
      if (ts.isJsxAttribute(p))
        return property || visibleAttributes.has(p.name.getText(ast));
      if (ts.isJsxExpression(p)) {
        if (ts.isJsxElement(p.parent) || ts.isJsxFragment(p.parent))
          return true;
      }
      if (ts.isFunctionLike(p)) return false;
    }
    return false;
  }
  function visit(node) {
    if (ts.isJsxText(node) && human(node.text.trim()) && !covered(node))
      add(node, "unmarked JSX text", node.text.trim());
    if (
      ts.isStringLiteralLike(node) &&
      human(node.text) &&
      !covered(node) &&
      output(node)
    )
      add(node, "unmarked visible string", node.text);
    if (
      ts.isTemplateExpression(node) &&
      human(
        node.head.text + node.templateSpans.map((s) => s.literal.text).join(""),
      ) &&
      !covered(node) &&
      output(node)
    )
      add(node, "unmarked visible interpolation", node.getText(ast));
    if (
      (ts.isCallExpression(node) &&
        ["t", "translate", "plural", "selectOrdinal"].includes(
          node.expression.getText(ast),
        )) ||
      (ts.isTaggedTemplateExpression(node) &&
        ["t", "translate"].includes(node.tag.getText(ast)))
    ) {
      const parent = node.parent;
      if (
        ts.isBinaryExpression(parent) &&
        comparisons.has(parent.operatorToken.kind)
      )
        add(node, "translation in control-flow comparison", node.getText(ast));
      if (
        ts.isCallExpression(parent) &&
        /\.(includes|has|get|startsWith|endsWith)$/.test(
          parent.expression.getText(ast),
        )
      )
        add(node, "translation in identifier lookup", node.getText(ast));
      if (
        ts.isCallExpression(parent) &&
        parent.expression.getText(ast) === "countLabel" &&
        parent.arguments[1] === node
      )
        add(node, "translation in count-kind identifier", node.getText(ast));
      for (let p = node.parent; p; p = p.parent) {
        if (
          ts.isTaggedTemplateExpression(p) &&
          ["t", "translate"].includes(p.tag.getText(ast))
        ) {
          add(node, "uncompiled nested translation macro", node.getText(ast));
          break;
        }
        if (ts.isJsxAttribute(p) && identifiers.has(p.name.getText(ast)))
          add(node, "translation in identifier attribute", p.name.getText(ast));
        if (ts.isPropertyAssignment(p) && identifiers.has(p.name.getText(ast)))
          add(node, "translation in identifier property", p.name.getText(ast));
        if (
          ts.isVariableDeclaration(p) &&
          /Class(?:Name)?$/.test(p.name.getText(ast))
        )
          add(node, "translation in CSS class variable", p.name.getText(ast));
        if (ts.isFunctionLike(p)) break;
      }
      let fn = node.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      if (!fn) add(node, "eager module-level translation", node.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return issues;
}
