import { TextInput } from "react-native";
import Animated, {
  Easing,
  type EntryExitAnimationFunction,
  LinearTransition,
  withTiming,
} from "react-native-reanimated";

// The composer and conversation panel wrap liquid-glass surfaces (GlassView /
// SwiftUI glassEffect). iOS 26 glass stops rendering — permanently, until the
// view remounts — when it or any ancestor has opacity < 1 while the effect is
// applied (expo/expo#41024), and an opacity-based `entering` that never fires
// leaves the whole subtree stuck invisible at opacity 0. So every mount/unmount
// transition here must be transform-only: never animate opacity around glass.
export const composerLayoutTransition = LinearTransition.springify()
  .mass(0.85)
  .damping(22)
  .stiffness(260);
export const composerEnterTransition: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { transform: [{ scale: 0.9 }] },
    animations: {
      transform: [{ scale: withTiming(1, { duration: 130, easing: Easing.out(Easing.quad) }) }],
    },
  };
};
export const composerExitTransition: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { transform: [{ scale: 1 }] },
    animations: {
      transform: [{ scale: withTiming(0.9, { duration: 90, easing: Easing.in(Easing.quad) }) }],
    },
  };
};
export const panelEnterTransition: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { transform: [{ translateY: 14 }, { scale: 0.98 }] },
    animations: {
      transform: [
        { translateY: withTiming(0, { duration: 160, easing: Easing.out(Easing.quad) }) },
        { scale: withTiming(1, { duration: 160, easing: Easing.out(Easing.quad) }) },
      ],
    },
  };
};
export const panelExitTransition: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { transform: [{ translateY: 0 }, { scale: 1 }] },
    animations: {
      transform: [
        { translateY: withTiming(14, { duration: 120, easing: Easing.in(Easing.quad) }) },
        { scale: withTiming(0.98, { duration: 120, easing: Easing.in(Easing.quad) }) },
      ],
    },
  };
};
export const searchLayoutTransition = LinearTransition.springify()
  .mass(0.8)
  .damping(24)
  .stiffness(280);
export const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);
