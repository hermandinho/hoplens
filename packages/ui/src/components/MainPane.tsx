import { Details } from "./Details";
import { Journey } from "./Journey";
import { RequestBuilder } from "./RequestBuilder";

export function MainPane() {
  return (
    <main id="main" class="main" aria-label="Request builder, journey and details">
      <RequestBuilder />
      <Journey />
      <Details />
    </main>
  );
}
