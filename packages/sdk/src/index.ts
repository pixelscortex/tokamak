// Public portable SDK. Build-time helpers stay in tools/ and are not exported,
// so importing the SDK in QuickJS cannot load Bun or Node tooling.
export { hook, createHook, createHookRegistry, hookMetadata, invokeHook } from "./hooks";
export { v, validate } from "./validators";
export { contract, provide } from "./internal/contracts";
export type { Contract, ContractTarget, Provider } from "./internal/contracts";

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
  internalQuery,
  internalMutation,
  internalAction,
  pluginOnly,
  fail,
  isFailure,
  createFunctions,
  createRegistry,
  functionMetadata,
  invokeFunction,
  FALLBACK_LOCAL_DEVICE,
  LOCAL_USER,
  SERVER_DEVICE_ID,
  isServerCall,
} from "./functions";
export type {
  FunctionDefinition,
  Failure,
  FunctionKind,
  FunctionBuilder,
  FunctionRegistry,
  QueryContext,
  User,
  Device,
  AuthContext,
  CallContext,
  MutationContext,
  ActionContext,
  CallerActionContext,
  ActionTarget,
  ActionOptions,
  MachineFailure,
  PluginCalls,
  WireResult,
} from "./functions";
export type { LocalProcess, LocalProcessOptions, RunningProcess } from "./local";
export { within, TIMED_OUT } from "./within";

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
export type {
  FunctionReference,
  ApiFromModule,
  InternalFromModule,
  PluginFunctionsFromModule,
  ReferenceFromDefinition,
  ArgsOf,
  ResultOf,
} from "./api";

export { TokamakClient } from "./client";
export { authCaller, memberFields, onMember } from "./auth";
export type { MemberHook } from "./auth";
export type { ClientTransport, LocalTransport, SubscriptionEvent } from "./client";
export { isLocalReloadTimeout, LocalReloadTimeout } from "./client";
export { InProcessTransport, WebSocketTransport, RemoteFunctionError } from "./transport";
export { threadRecordBytes, threadPrompt } from "./thread-context";
export type { MessageConnection, ClientWebSocket } from "./transport";
export type { Request, Event } from "./protocol";

export type { Id, JsonValue, JsonObject } from "./values";
