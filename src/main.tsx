import { render } from "solid-js/web";
import App from "./ui/App";

const root = document.getElementById("app");
if (root) render(() => <App />, root);
