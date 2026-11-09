/** One registry per native window. Factories contain plugin code only; the host
 * owns Solid, renderer IDs, SDK context and router identity for the whole window. */
import { catchError, createRoot } from "solid-js";

export type ModuleExports = Record<string, unknown>;
type Factory = (require: (name: string) => ModuleExports, exports: ModuleExports, module: { exports: ModuleExports }) => void;
interface Definition { dependencies: readonly string[]; factory: Factory }
const canonical = (name: string) => /^@plugins\/[^/]+$/.test(name) ? `${name}/ui` : name;

export class ModuleRegistry {
  private readonly host = new Map<string, ModuleExports>();
  private readonly definitions = new Map<string, Definition>();
  private readonly instances = new Map<string, ModuleExports>();
  private readonly disposers = new Map<string, () => void>();
  private readonly errors = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<(cause: unknown) => void>>();

  onError(name: string, listener: (cause: unknown) => void): () => void {
    name = canonical(name);
    let listeners = this.listeners.get(name);
    if (!listeners) this.listeners.set(name, listeners = new Set());
    listeners.add(listener);
    if (this.errors.has(name)) listener(this.errors.get(name));
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(name); };
  }
  notifyError(name: string, cause: unknown): void { this.fail(name, cause); }
  private fail(name: string, cause: unknown): void {
    // Module roots belong to their defining plugin; importers consume that
    // module too, so every mounted consumer gets its own error card.
    for (const affected of this.affected([name])) {
      this.errors.set(affected, cause);
      for (const listener of [...(this.listeners.get(affected) ?? [])]) listener(cause);
    }
  }
  private accepting: string | undefined;
  provide(name: string, exports: ModuleExports): void {
    if (this.host.has(name)) throw new Error(`Host module already provided: ${name}`);
    this.host.set(name, exports);
  }

  register(name: string, dependencies: string[], factory: Factory): void {
    if (name !== this.accepting || this.definitions.has(name)) throw new Error(`Unexpected plugin registration: ${name}`);
    if (!Array.isArray(dependencies) || dependencies.some(value => typeof value !== "string") || typeof factory !== "function") throw new Error("Invalid UI registration");
    this.definitions.set(name, { dependencies: dependencies.map(canonical), factory });
  }

  evaluate(name: string, code: string): void {
    if (this.accepting) throw new Error("Nested module registration");
    this.accepting = name;
    try {
      // Assets come from the owner's verified immutable installation, not user
      // data. Function scope keeps declarations outside the shell's scope.
      // Evaluation gets one capability for this module only. Never publish the
      // registry itself: provide/remove/require are host administration APIs.
      let registering = true;
      const api = Object.freeze({
        register: (id: string, dependencies: string[], factory: Factory) => {
          if (!registering || id !== name) throw new Error(`Unexpected plugin registration: ${id}`);
          this.register(id, dependencies, factory);
        },

      });
      try {
        // The globalThis spelling supports existing artifacts, but its facade
        // has the same scoped capability, never the host's global object.
        new Function("globalThis", "__tokamakModules", code)(Object.freeze({ __tokamakModules: api }), api);
      } finally { registering = false; }
      if (!this.definitions.has(name)) throw new Error(`UI did not register ${name}`);
    } catch (error) {
      this.definitions.delete(name);
      throw error;
    } finally { this.accepting = undefined; }
  }

  dependencies(name: string): readonly string[] { return this.definitions.get(canonical(name))?.dependencies ?? []; }
  has(name: string): boolean { return this.host.has(canonical(name)) || this.definitions.has(canonical(name)); }

  require(name: string): ModuleExports {
    name = canonical(name);
    const cached = this.host.get(name) ?? this.instances.get(name);
    if (cached) return cached;
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`Module is not loaded: ${name}`);
    const module = { exports: {} as ModuleExports };
    this.instances.set(name, module.exports);
    try {
      catchError(() => createRoot(dispose => {
        this.disposers.set(name, dispose);
        definition.factory(dependency => {
          if (!definition.dependencies.includes(canonical(dependency))) throw new Error(`Undeclared module dependency: ${dependency}`);
          return this.require(dependency);
        }, module.exports, module);
      }), cause => this.fail(name, cause));
      if (this.errors.has(name)) throw this.errors.get(name);
      this.instances.set(name, module.exports);
      return module.exports;
    } catch (error) { this.remove([name]); throw error; }
  }

  /** Return the transitive importer set before deleting its graph. The shell
   * retires Solid owners first, so no old component can recreate stale state. */
  affected(names: Iterable<string>): Set<string> {
    const affected = new Set([...names].map(canonical));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, definition] of this.definitions) {
        if (!affected.has(name) && definition.dependencies.some(dep => affected.has(dep))) {
          affected.add(name); changed = true;
        }
      }
    }
    return affected;
  }
  remove(names: Iterable<string>): void {
    for (const name of names) {
      try { this.disposers.get(name)?.(); }
      catch { /* One plugin cleanup must not strand the other retiring modules. */ }
      finally { this.disposers.delete(name); this.instances.delete(name); this.definitions.delete(name); this.errors.delete(name); }
    }
  }
}
