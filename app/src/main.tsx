import { render } from "@solidjs/web";
import { ClientRouter } from "./router";
import "./styles.css";
render(() => <ClientRouter />, document.getElementById("root")!);
