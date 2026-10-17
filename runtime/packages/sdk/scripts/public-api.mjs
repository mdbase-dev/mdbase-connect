// Public API snapshot (R5.8). Dumps the type-level shape of everything each
// package.json entry point exports, plus SDK-declared types reachable from those
// signatures, so a member added/removed/retyped anywhere public shows up as a
// diff (e.g. an optional `closed?(): boolean` added to an exported interface).
//   node scripts/public-api.mjs           check against public-api.txt (exit 1 on drift)
//   node scripts/public-api.mjs --update  rewrite public-api.txt after review
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SNAPSHOT = resolve(root, "public-api.txt");

export function publicApi() {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const entries = Object.entries(pkg.exports).map(([name, value]) =>
    [name, resolve(root, value.types.replace(/^\.\/dist\//, "src/").replace(/\.d\.ts$/, ".ts"))]);
  const config = ts.getParsedCommandLineOfConfigFile(resolve(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); } });
  const program = ts.createProgram(entries.map(([, file]) => file), { ...config.options, noEmit: true });
  const checker = program.getTypeChecker(), src = resolve(root, "src") + "/";
  const F = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;
  const str = (type, node) => checker.typeToString(type, node, F);
  const own = sym => sym?.declarations?.some(d => d.getSourceFile().fileName.startsWith(src));
  const id = sym => `${sym.name}@${relative(src, sym.declarations[0].getSourceFile().fileName)}`;
  const queue = [], ids = new Map(), visited = new Set();
  const enqueue = sym => { if (!sym || !own(sym)) return; const key = id(sym); if (!ids.has(key)) { ids.set(key, sym); queue.push(sym); } };
  function visit(type) {
    if (!type || visited.has(type)) return; visited.add(type);
    if (type.aliasSymbol) { enqueue(type.aliasSymbol); type.aliasTypeArguments?.forEach(visit); return; }
    if (type.isUnionOrIntersection()) return type.types.forEach(visit);
    if (type.flags & ts.TypeFlags.Object) {
      const sym = type.symbol;
      if (sym && sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.Enum)) enqueue(sym);
      if (type.objectFlags & ts.ObjectFlags.Reference) checker.getTypeArguments(type).forEach(visit);
      if (sym && own(sym) && sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) return;
      if (type.objectFlags & ts.ObjectFlags.Anonymous || type.objectFlags & ts.ObjectFlags.Mapped) {
        for (const p of checker.getPropertiesOfType(type)) visit(checker.getTypeOfSymbol(p));
        for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct]) for (const s of checker.getSignaturesOfType(type, kind)) signature(s);
      }
    }
  }
  function signature(s) { s.parameters.forEach(p => visit(checker.getTypeOfSymbol(p))); visit(checker.getReturnTypeOfSignature(s)); }
  const hidden = (p, d) => p.name.startsWith("__#") || p.name.startsWith("#") || (d && ts.getCombinedModifierFlags(d) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
  function members(type, node, indent = "  ") {
    const out = [];
    for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct]) for (const s of checker.getSignaturesOfType(type, kind)) { out.push(`${indent}${kind === ts.SignatureKind.Construct ? "new " : ""}${checker.signatureToString(s, node, F)}`); signature(s); }
    for (const info of checker.getIndexInfosOfType(type)) { out.push(`${indent}[key: ${str(info.keyType)}]: ${str(info.type)}`); visit(info.type); }
    for (const p of [...checker.getPropertiesOfType(type)].sort((a, b) => a.name.localeCompare(b.name))) {
      const d = p.valueDeclaration ?? p.declarations?.[0];
      if (p.name === "prototype" || hidden(p, d)) continue;
      const t = checker.getTypeOfSymbolAtLocation(p, d ?? node), ro = d && (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Readonly || (ts.isGetAccessor(d) && !p.declarations.some(ts.isSetAccessor)));
      out.push(`${indent}${ro ? "readonly " : ""}${p.name}${p.flags & ts.SymbolFlags.Optional ? "?" : ""}: ${str(t, d)}`); visit(t);
    }
    return out;
  }
  function body(sym) {
    const node = sym.declarations[0], lines = [], f = sym.flags;
    if (f & ts.SymbolFlags.TypeAlias) { const t = checker.getDeclaredTypeOfSymbol(sym); lines.push(`  = ${checker.typeToString(t, node, F | ts.TypeFormatFlags.InTypeAlias)}`); visit(t); }
    if (f & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) {
      const t = checker.getDeclaredTypeOfSymbol(sym), params = t.typeParameters?.map(p => str(p)).join(", ");
      if (params) lines.push(`  <${params}>`);
      lines.push(...members(t, node));
      if (f & ts.SymbolFlags.Class) lines.push(...members(checker.getTypeOfSymbol(sym), node, "  static "));
    }
    if (f & ts.SymbolFlags.Enum) for (const m of checker.getExportsOfModule(sym)) lines.push(`  ${m.name} = ${JSON.stringify(checker.getConstantValue(m.valueDeclaration))}`);
    if (f & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable) && !(f & ts.SymbolFlags.Class)) { const t = checker.getTypeOfSymbol(sym); lines.push(`  : ${str(t, node)}`); visit(t); }
    if (f & ts.SymbolFlags.Module && !(f & (ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Enum))) for (const m of checker.getExportsOfModule(sym)) lines.push(`  export ${m.name}`);
    return lines;
  }
  const out = ["# @mdbase-dev/sdk public API snapshot. Generated by scripts/public-api.mjs; review diffs, then --update.", ""];
  for (const [name, file] of entries) {
    out.push(`## entry ${name}`);
    const module = checker.getSymbolAtLocation(program.getSourceFile(file));
    for (const e of [...checker.getExportsOfModule(module)].sort((a, b) => a.name.localeCompare(b.name))) {
      const sym = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
      if (!own(sym)) { out.push(`${e.name} (external)`); continue; }
      out.push(`${e.name} -> ${id(sym)}`); enqueue(sym);
    }
    out.push("");
  }
  const bodies = new Map();
  while (queue.length) { const sym = queue.shift(); bodies.set(id(sym), body(sym)); }
  out.push("## declarations", "");
  for (const key of [...bodies.keys()].sort()) out.push(key, ...bodies.get(key), "");
  // Module symbols are named by absolute path; keep the snapshot checkout-independent.
  return out.join("\n").split(src).join("src/");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const current = publicApi();
  if (process.argv.includes("--update")) { writeFileSync(SNAPSHOT, current); console.log(`wrote ${relative(process.cwd(), SNAPSHOT)}`); }
  else {
    let saved = ""; try { saved = readFileSync(SNAPSHOT, "utf8"); } catch { /* missing snapshot is drift */ }
    if (saved !== current) { console.error("Public API changed. Review the diff (node scripts/public-api.mjs --update && git diff public-api.txt), note breaking changes, then commit the snapshot."); process.exit(1); }
    console.log("public API matches public-api.txt");
  }
}
