import { createHash } from "node:crypto";
import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { definitionTypeInfo, runtimeExportNames } from "./plugin-compiler.mjs";

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
      const place =
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (p) => ts.isPropertyAssignment(p) && p.name.getText(file).replace(/['"]/g, "") === "place",
            )?.initializer
          : undefined;
      if (
        !key ||
        !ts.isStringLiteralLike(key) ||
        !contractName.test(key.text) ||
        (options && (!place || !ts.isStringLiteralLike(place) || !["local", "server"].includes(place.text)))
      )
        throw new Error(`${entry}: contract names and places must be literals`);
      if (contracts.some((item) => item.name === key.text))
        throw new Error(`${entry}: duplicate contract ${key.text}`);
      contracts.push({
        exported: name.text,
        name: key.text,
        place: place?.text ?? "server",
        declarationHash,
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
      if (!call || !ts.isCallExpression(call) || call.arguments.length !== 2)
        throw new Error(`${path}: export the result of provide(contract, implementation) directly`);
      seen.add(target);
      const [key, implementation] = call.arguments;
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
      const local = relative(root, path).split(sep).join("/");
      const methods = [];
      if (memberHook) {
        if (owner !== "auth" || !contract.memberHook)
          throw new Error(`${path}: onMember requires an auth membership event`);
        methods.push({ member: MEMBER_HOOK_RUN, kind: "mutation", field: implementation, argument: true });
      } else if (contract.place === "server") {
        if (!ts.isObjectLiteralExpression(implementation))
          throw new Error(`${path}: a server provider must declare its members in an object literal`);
        for (const field of implementation.properties) {
          if (
            (!ts.isShorthandPropertyAssignment(field) && !ts.isPropertyAssignment(field)) ||
            !(ts.isIdentifier(field.name) || ts.isStringLiteralLike(field.name)) ||
            !contractName.test(field.name.text)
          )
            throw new Error(`${path}: a server provider requires statically named members`);
          const value = ts.isShorthandPropertyAssignment(field) ? field.name : field.initializer;
          const actual = checker.getTypeAtLocation(value);
          const info = definitionTypeInfo(checker, actual, value);
          if (info?.kind === "local")
            throw new Error(
              `${path}: contract "${contract.name}" is server-side. To provide local functions, declare it with { place: "local" }`,
            );
          if (info?.kind) methods.push({ member: field.name.text, kind: info.kind, field });
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
      });
    }
  }
  return providers;
}

// Names are private registry keys, disjoint from authored modules. The
// manifest ties each such key to one provider and one contract owner.
export const contractTarget = (provider, method) => `$contract:${provider.registration}:${method.member}`;

export function contractManifest(root, namespace, providers = []) {
  const contracts = contractDeclarations(contractEntry(root)).map(({ name, place, declarationHash }) => ({
    name,
    place,
    declarationHash,
  }));
  return {
    contracts,
    contractProviders: providers.map((p) => ({
      owner: p.owner ?? namespace,
      name: p.name,
      declarationHash: p.declarationHash,
      place: p.place,
      registration: p.registration,
      methods: Object.fromEntries(p.methods.map((method) => [method.member, contractTarget(p, method)])),
    })),
  };
}
