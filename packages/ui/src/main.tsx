import { render } from "preact";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/layout.css";
import "./styles/overview.css";
import "./styles/request.css";
import "./styles/canvas.css";
import "./styles/log.css";
import "./styles/palette.css";
// Last: the phone layout (WP11) overrides the sheets above at equal specificity.
import "./styles/mobile.css";

const target = document.getElementById("app");
if (target) render(<App />, target);
