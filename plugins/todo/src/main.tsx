import { itemRenderer, view } from "@tokamak/sdk";
import Todos from "./todos";
import Card from "./todo-card";

export const Todo = view({ route: "/" }, Todos);
export { default as Todos } from "./todos";

export const TodoCard = itemRenderer({ type: "todo.card" }, Card);
