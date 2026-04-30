import type { ReactNode } from "react";

import { CardStack, CardStackContent, CardStackHeader } from "../components/card-stack";

export function SourceAdvancedSettings(props: {
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
}) {
  return (
    <CardStack collapsible defaultOpen={props.defaultOpen ?? false}>
      <CardStackHeader>Advanced settings</CardStackHeader>
      <CardStackContent>{props.children}</CardStackContent>
    </CardStack>
  );
}
