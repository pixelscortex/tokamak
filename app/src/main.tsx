/** The sole native frontend entry mounts the core Todo screen, without routing. */
import { mount } from "@tokamak/render";
import Todos from "./pages/todos";

mount(Todos);
