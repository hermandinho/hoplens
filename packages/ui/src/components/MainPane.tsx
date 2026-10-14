import { Details } from "./Details";
import { JourneyPane } from "./JourneyPane";
import { RequestBuilder } from "./RequestBuilder";

export function MainPane() {
  return (
    <main id="main" class="main" aria-label="Request builder, journey and details">
      <RequestBuilder />
      <JourneyPane />
      <Details />
    </main>
  );
}
