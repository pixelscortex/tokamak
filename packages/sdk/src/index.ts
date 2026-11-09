// Public portable SDK. Build-time helpers stay in tools/ and are not exported,
// so importing the SDK in QuickJS cannot load Bun or Node tooling.
export { v, validate } from "./validators";
export { definePlugin } from "./plugin";
export type { PluginDefinition } from "./plugin";
export type { Validator, ValidatorDescription, Fields, Infer, ObjectValue } from "./validators";

export { defineSchema, defineTable } from "./schema";
export type { SchemaDefinition, TableDefinition, DataModel, ModelFromSchema } from "./schema";

export {
  query,
  mutation,
  createFunctions,
  createRegistry,
  functionMetadata,
  invokeFunction,
} from "./functions";
export type {
  FunctionDefinition,
  FunctionKind,
  FunctionBuilder,
  FunctionRegistry,
  QueryContext,
  MutationContext,
  PluginCalls,
  WireResult,
} from "./functions";

export type { DatabaseReader, DatabaseWriter, Doc, TableQuery } from "./database";

export type {
  HostBridge,
  HostOperations,
  HostOperation,
  StoredDocument,
  EqualityClause,
  QueryRequest,
} from "./host";

export { createApi, functionName } from "./api";
export type { FunctionReference, ApiFromModule, ArgsOf, ResultOf } from "./api";

export { TokamakClient } from "./client";
export type { ClientTransport, SubscriptionEvent } from "./client";
export { InProcessTransport, WebSocketTransport } from "./transport";
export type { MessageConnection, ClientWebSocket } from "./transport";
export type { Request, Event } from "./protocol";

export type { Id, JsonValue, JsonObject } from "./values";

export { view, itemRenderer, toolbar, command, entityCard } from "./contributions";
export type { Contribution, ContributionKind, ContributionOptions } from "./contributions";
