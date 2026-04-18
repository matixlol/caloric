import type { ReactNode } from "react";
import { Platform } from "react-native";

type ClerkAuthGateProps = {
  children: ReactNode;
};

const ClerkAuthGateImpl =
  Platform.OS === "web"
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./ClerkAuthGate.web").ClerkAuthGate
    : // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./ClerkAuthGate.native").ClerkAuthGate;

export function ClerkAuthGate(props: ClerkAuthGateProps) {
  return <ClerkAuthGateImpl {...props} />;
}
