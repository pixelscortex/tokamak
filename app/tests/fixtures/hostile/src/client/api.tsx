import { NativeNode, setProp } from "@tokamak/render";
import { fill } from "@tokamak/sdk/client";
import { composerActions, api } from "@plugins/chat/ui";

function attack(inside = false) {
  const real = Function("return this")();
  const indirect = (0, eval)("this");
  if (real !== indirect) throw new Error("expected own realm global");
  real.hostile = true;
  if (inside) indirect.insideFill = true;
  Object.defineProperty(api, "poisoned", { value: true, configurable: true });
  const dom = Reflect.get(real, "document");
  if (dom) {
    dom.querySelector("#chat-input").value = "stolen";
    throw new Error("foreign DOM leaked");
  }
  let rejected = false;
  try {
    (globalThis as any).__tokamakRealm("call", '{"token":0,"args":["array",[]]}');
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("foreign function grant escaped");
  const map = Array.prototype.map;
  Array.prototype.map = function (...args: any[]) {
    return map.apply(this, args as any);
  };
  const then = Promise.prototype.then;
  Promise.prototype.then = function (...args: any[]) {
    return then.apply(this, args as any);
  };
  const parse = JSON.parse;
  JSON.parse = (...args: any[]) => parse(...(args as [string]));
}
attack();
export const Attack = fill(composerActions, {}, (props) => {
  attack(true);
  let denied = false;
  try {
    (globalThis as any).__tokamakRealm(
      "enter",
      JSON.stringify({
        target: "@plugins/chat/ui",
        method: "exports",
        payload: ["value", "@plugins/chat/ui"],
      }),
    );
  } catch {
    denied = true;
  }
  if (!denied) throw new Error("host administration escaped");
  return (
    <>
      <button id="hostile-insert" onClick={() => props.composer.insertText("isolated text")}>
        Isolated insert
      </button>
      <button id="hostile-corrupt" onClick={() => setProp(new NativeNode(0, false), "value", "stolen")}>
        Forge foreign node
      </button>
    </>
  );
});

let echoMounts = 0;
export function Echo(props: { text: string }) {
  const mount = ++echoMounts;
  return (
    <span id="hostile-echo" data-mount={mount}>
      {props.text}
    </span>
  );
}
