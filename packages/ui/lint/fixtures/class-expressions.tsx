import { Button } from "@tokamak/ui";
import { cn, tv } from "../../src/cn";

export const ClassExpressions = (props: { expanded: boolean }) => (
  <>
    <div class={cn("flex", props.expanded && "hover:-mt-2")} />
    <div class={tv({ base: "-mx-2" })()} />
    <div class={`flex ${props.expanded ? "-ms-3" : "ms-3"}`} />
    <Button lead={<span class={cn(props.expanded ? "lowercase" : "flex", props.expanded && "sr-only")} />}>
      <span class={tv({ slots: { root: "uppercase" } })().root()}>Uppercase</span>
      <span class={`underline ${props.expanded ? "flex" : "block"}`}>Underlined</span>
    </Button>
  </>
);
