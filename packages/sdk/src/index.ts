// Public portable SDK. Build-time helpers stay in tools/ and are not exported,
// so importing the SDK in QuickJS cannot load Bun or Node tooling.
export { v, validate } from "./validators";
export { definePlugin } from "./plugin";
export type { PluginDefinition } from "./plugin";
export type { Validator, ValidatorDescription, Fields, Infer, ObjectValue } from "./validators";

export { defineSchema, defineTable, schemaMetadata } from "./schema";
export type {
  SchemaDefinition,
  TableDefinition,
  IndexDefinition,
  DataModel,
  ModelFromSchema,
} from "./schema";

export {
  query,
  mutation,
  action,
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
  User,
  MutationContext,
  ActionContext,
  PluginCalls,
  WireResult,
} from "./functions";

export type {
  DatabaseReader,
  DatabaseWriter,
  Doc,
  TableQuery,
  FilteredQuery,
  QueryResult,
  IndexRange,
  IndexBounds,
} from "./database";

export type {
  HostBridge,
  ActionSignal,
  HostOperations,
  HostOperation,
  StoredDocument,
  EqualityClause,
  RangeClause,
  IndexQuery,
  QueryRequest,
} from "./host";

export { createApi, functionName } from "./api";
export type { FunctionReference, ApiFromModule, ArgsOf, ResultOf } from "./api";

export { TokamakClient } from "./client";
export type { ClientTransport, SubscriptionEvent } from "./client";
export { InProcessTransport, WebSocketTransport, RemoteFunctionError } from "./transport";
export { boundedThreadHistory, threadPrompt } from "./thread-context";
export type { MessageConnection, ClientWebSocket } from "./transport";
export type { Request, Event } from "./protocol";

export type { Id, JsonValue, JsonObject } from "./values";

export { view, itemRenderer, toolbar, command, entityCard } from "./contributions";
export type { Contribution, ContributionKind, ContributionOptions } from "./contributions";
