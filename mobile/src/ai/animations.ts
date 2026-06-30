import { TextInput } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";

export const composerLayoutTransition = LinearTransition.springify()
  .mass(0.85)
  .damping(22)
  .stiffness(260);
export const composerEnterTransition = FadeIn.duration(130);
export const composerExitTransition = FadeOut.duration(90);
export const searchLayoutTransition = LinearTransition.springify()
  .mass(0.8)
  .damping(24)
  .stiffness(280);
export const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);
