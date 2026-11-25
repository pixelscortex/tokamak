import { createHash } from "node:crypto";
import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { declaredActionPlacement, definitionTypeInfo, runtimeExportNames } from "./plugin-compiler.mjs";

import { contractName, MEMBER_HOOK_RUN } from "../src/internal/contracts.ts";
const unalias = (checker, symbol) =>
  symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
const brand = (type, name) => type.getProperties().some((p) => p.name.startsWith(`__@${name}@`));

export const contractEntry = (folder) => resolve(folder, "src/contracts.ts");

export function importedContractEntry(root, id) {
  if (id === "auth") return resolve(import.meta.dirname, "../core-contracts/auth.ts");
  const source = contractEntry(resolve(root, "..", id));
  // Optional dependencies can distribute their contract types separately from
  // the defining plugin. The checked-in copy is never executable at runtime.
  return existsSync(source) ? source : resolve(root, "contracts", id + ".ts");
}

function nonDataMethods(entry, exported, data, file) {
  const declared = new Set(
    data && ts.isArrayLiteralExpression(data)
      ? data.elements.filter(ts.isStringLiteralLike).map((name) => name.text)
      : [],
  );
  // The normal path needs only the syntax tree. Resolve the contract's type to
  // report method names only when rejecting an old or incomplete declaration.
  const program = ts.createProgram([entry], { noEmit: true, skipLibCheck: true });
  const source = program.getSourceFile(entry);
  const checker = program.getTypeChecker();
  const call = source?.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((declaration) => declaration.name.getText(source) === exported)?.initializer;
  const node = call && ts.isCallExpression(call) && call.typeArguments?.[0];
  const names = node
    ? checker
        .getTypeFromTypeNode(node)
        .getProperties()
        .flatMap((property) => {
          const type = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, node));
          return type.getCallSignatures().length && !declared.has(property.name) ? [property.name] : [];
        })
    : [];
  return names.length ? names.join(", ") : (data?.getText(file) ?? "all methods");
}

/** A public contract module describes types and keys, and is never loaded by its providers. */
export function contractDeclarations(entry) {
  if (!existsSync(entry)) return [];
  const text = readFileSync(entry, "utf8");
  const declarationHash = createHash("sha256").update(text).digest("hex");
  const file = ts.createSourceFile(entry, text, ts.ScriptTarget.Latest, true);
  const imports = new Set();
  const contracts = [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === "@tokamak/sdk")
      for (const field of statement.importClause?.namedBindings?.elements ?? [])
        if ((field.propertyName ?? field.name).text === "contract") imports.add(field.name.text);
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    for (const { name, initializer: call } of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(name) ||
        !call ||
        !ts.isCallExpression(call) ||
        !imports.has(call.expression.getText(file))
      )
        throw new Error(`${entry} must export contracts declared with contract<T>("name", options)`);
      const [key, options] = call.arguments;
      const property = (name) =>
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (p) => ts.isPropertyAssignment(p) && p.name.getText(file).replace(/['"]/g, "") === name,
            )?.initializer
          : undefined;
      const place = property("place");
      const on = property("on");
      if (
        !key ||
        !ts.isStringLiteralLike(key) ||
        !contractName.test(key.text) ||
        (options &&
          (on
            ? place || !ts.isStringLiteralLike(on) || on.text !== "caller"
            : !place || !ts.isStringLiteralLike(place) || !["local", "server"].includes(place.text)))
      )
        throw new Error(`${entry}: contract names and places must be literals`);
      const local = on !== undefined || place?.text === "local";
      if (contracts.some((item) => item.name === key.text))
        throw new Error(`${entry}: duplicate contract ${key.text}`);
      const data = property("dataMethods");
      if (place?.text === "local" && data?.kind !== ts.SyntaxKind.TrueKeyword) {
        const missing = nonDataMethods(entry, name.text, data, file);
        throw new Error(
          `${entry}: local contract "${key.text}" requires dataMethods: true on QuickJS; non-data methods: ${missing}`,
        );
      }
      if (data && !local) throw new Error(`${entry}: dataMethods requires a local contract`);
      contracts.push({
        exported: name.text,
        name: key.text,
        place: local ? "local" : "server",
        declarationHash,
        dataMethods: local ? true : undefined,
        memberHook: call.typeArguments?.[0]?.getText(file) === "MemberHook",
      });
    }
  }
  return contracts;
}

export function discoverProviders(root, files, program, checker) {
  const entry = contractEntry(root);
  const providers = [];
  const seen = new Set();
  for (const path of files) {
    const source = program.getSourceFile(path);
    const module = checker.getSymbolAtLocation(source);
    if (!module) continue;
    const runtime = runtimeExportNames(checker, module);
    for (const exported of checker.getExportsOfModule(module)) {
      if (!runtime.has(exported.name)) continue;
      const target = unalias(checker, exported);
      const type = checker.getTypeOfSymbolAtLocation(target, source);
      if (seen.has(target) || !brand(type, "providerBrand")) continue;
      const memberHook = brand(type, "memberHookProviderBrand");
      const declaration = target.valueDeclaration;
      if (!declaration || declaration.getSourceFile() !== source) continue;
      const call = ts.isExportAssignment(declaration) ? declaration.expression : declaration.initializer;
      if (!call || !ts.isCallExpression(call) || ![2, 3].includes(call.arguments.length))
        throw new Error(`${path}: export the result of provide(contract, implementation) directly`);
      seen.add(target);
      const [key, implementation, options] = call.arguments;
      const keySymbol = unalias(
        checker,
        checker.getSymbolAtLocation(ts.isPropertyAccessExpression(key) ? key.name : key),
      );
      const keyFile = keySymbol?.valueDeclaration?.getSourceFile().fileName;
      const imported =
        keyFile && /[\\/]\.tokamak[\\/]types[\\/]([^\\/]+)[\\/]contracts\.d\.ts$/.exec(keyFile);
      const owner = imported?.[1];
      const ownerEntry = owner ? importedContractEntry(root, owner) : entry;
      const contract =
        (owner || keyFile === entry) &&
        contractDeclarations(ownerEntry).find((item) => item.exported === keySymbol?.name);
      if (!contract)
        throw new Error(
          `${path}: provide requires a named contract from src/contracts.ts or plugin:<id>/contracts`,
        );
      let unavailable;
      if (options) {
        const field = ts.isObjectLiteralExpression(options) && options.properties[0];
        if (
          contract.place !== "local" ||
          !field ||
          options.properties.length !== 1 ||
          !ts.isPropertyAssignment(field) ||
          field.name.getText(source) !== "unavailable" ||
          !ts.isStringLiteralLike(field.initializer) ||
          !field.initializer.text ||
          Buffer.byteLength(field.initializer.text) > 1024
        )
          throw new Error(`${path}: provider options must be { unavailable: "message" } (up to 1024 bytes)`);
        unavailable = field.initializer.text;
      }
      const local = relative(root, path).split(sep).join("/");
      const methods = [];
      if (memberHook) {
        if (owner !== "auth" || !contract.memberHook)
          throw new Error(`${path}: onMember requires an auth membership event`);
        methods.push({ member: MEMBER_HOOK_RUN, kind: "mutation", field: implementation, argument: true });
      } else if (contract.place === "server" || ts.isObjectLiteralExpression(implementation)) {
        if (!ts.isObjectLiteralExpression(implementation))
          throw new Error(`${path}: a server provider must declare its members in an object literal`);
        for (const field of implementation.properties) {
          if (
            (!ts.isShorthandPropertyAssignment(field) && !ts.isPropertyAssignment(field)) ||
            !(ts.isIdentifier(field.name) || ts.isStringLiteralLike(field.name)) ||
            !contractName.test(field.name.text)
          ) {
            // Spread and computed Runner methods are resolved when the provider binds.
            if (contract.place === "local") continue;
            throw new Error(`${path}: a server provider requires statically named members`);
          }
          const value = ts.isShorthandPropertyAssignment(field) ? field.name : field.initializer;
          const actual = checker.getTypeAtLocation(value);
          const info = definitionTypeInfo(checker, actual, value);
          const expression = ts.isShorthandPropertyAssignment(field)
            ? checker.getShorthandAssignmentValueSymbol(field)?.valueDeclaration?.initializer
            : value;
          const on =
            info?.on ?? (info?.kind === "action" ? declaredActionPlacement(checker, expression) : undefined);
          if (
            contract.place === "local" &&
            info?.kind &&
            info.kind !== "local" &&
            (info.kind !== "action" || on !== "caller")
          )
            throw new Error(
              `${path}: contract "${contract.name}" method "${field.name.text}" requires local() or action({ on: "caller" })`,
            );
          if (contract.place === "server" && info?.kind === "local")
            throw new Error(
              `${path}: contract "${contract.name}" is server-side. To provide local functions, declare it with { place: "local", dataMethods: true }`,
            );
          if (info?.kind) methods.push({ member: field.name.text, kind: info.kind, on, field });
        }
      }
      providers.push({
        ...contract,
        exported: exported.name,
        owner,
        path,
        registration: `${local.replace(/\.tsx?$/, "")}:${exported.name}`,
        call,
        methods,
        unavailable,
      });
    }
  }
  return providers;
}

// Names are private registry keys, disjoint from authored modules. The
// manifest ties each such key to one provider and one contract owner.
export const contractTarget = (provider, method) => `$contract:${provider.registration}:${method.member}`;

export function contractManifest(root, namespace, providers = []) {
  const contracts = contractDeclarations(contractEntry(root)).map(
    ({ name, place, declarationHash, dataMethods }) => ({
      name,
      place,
      declarationHash,
      dataMethods,
    }),
  );
  return {
    contracts,
    contractProviders: providers.map((p) => ({
      owner: p.owner ?? namespace,
      name: p.name,
      declarationHash: p.declarationHash,
      place: p.place,
      dataMethods: p.dataMethods,
      registration: p.registration,
      unavailable: p.unavailable,
      methods: Object.fromEntries(
        p.place === "local" ? [] : p.methods.map((method) => [method.member, contractTarget(p, method)]),
      ),
    })),
  };
}
