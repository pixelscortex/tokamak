import { view } from "@tokamak/sdk";
import Todos from "./todos";

export const Todo = view({ route: "/" }, Todos);
export { default as Todos } from "./todos";
