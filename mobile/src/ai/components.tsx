import Ionicons from "@expo/vector-icons/Ionicons";
import { type ReactNode, useEffect, useState } from "react";
import { type ColorValue, type StyleProp, Text, View, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { type AppTheme } from "../theme/useAppTheme";
import {
  composerEnterTransition,
  composerExitTransition,
  composerLayoutTransition,
} from "./animations";
import { formatCalories } from "./helpers";
import { type AIStyles } from "./styles";
import { audioBubbleWaveHeights, recordingWaveHeights, type SearchResultFood } from "./types";

function TypingDot({ delay, color }: { delay: number; color: ColorValue }) {
  const opacity = useSharedValue(0.3);
  const scale = useSharedValue(0.8);

  useEffect(() => {
    opacity.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 400, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.3, { duration: 400, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      ),
    );
    scale.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 400, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.8, { duration: 400, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      ),
    );
  }, [delay, opacity, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  return (
    <Animated.View
      style={[
        {
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: color,
        },
        animatedStyle,
      ]}
    />
  );
}

export function TypingIndicator({ color }: { color: ColorValue }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 4 }}>
      <TypingDot delay={0} color={color} />
      <TypingDot delay={160} color={color} />
      <TypingDot delay={320} color={color} />
    </View>
  );
}

function RecordingWaveBar({ delay, height, color }: { delay: number; height: number; color: ColorValue }) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 420, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 420, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      ),
    );

    return () => {
      cancelAnimation(progress);
    };
  }, [delay, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 0.42 + progress.value * 0.42,
    transform: [{ scaleY: 0.72 + progress.value * 0.46 }],
  }));

  return (
    <Animated.View
      style={[
        {
          width: 3,
          height,
          borderRadius: 2,
          backgroundColor: color,
        },
        animatedStyle,
      ]}
    />
  );
}

export function RecordingWaveform({ color }: { color: ColorValue }) {
  return (
    <View
      style={{
        height: 30,
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
      }}
    >
      {recordingWaveHeights.map((height, index) => (
        <RecordingWaveBar
          key={`${height}-${index}`}
          delay={index * 55}
          height={height}
          color={color}
        />
      ))}
    </View>
  );
}

export function AudioBubbleWaveform({ color }: { color: ColorValue }) {
  return (
    <View style={{ height: 22, flexDirection: "row", alignItems: "center", gap: 3 }}>
      {audioBubbleWaveHeights.map((height, index) => (
        <View
          key={`${height}-${index}`}
          style={{
            width: 3,
            height,
            borderRadius: 2,
            backgroundColor: color,
            opacity: index % 3 === 0 ? 0.54 : 0.82,
          }}
        />
      ))}
    </View>
  );
}

export function RecordingCardView({
  children,
  style,
  progress,
}: {
  children: ReactNode;
  style: StyleProp<ViewStyle>;
  progress: SharedValue<number>;
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 0.88 + progress.value * 0.12,
    transform: [{ translateY: (1 - progress.value) * 8 }],
  }));

  return (
    <Animated.View
      entering={composerEnterTransition}
      exiting={composerExitTransition}
      layout={composerLayoutTransition}
      style={[style, animatedStyle]}
    >
      {children}
    </Animated.View>
  );
}

export function RecordingLockTarget({
  progress,
  locked,
  palette,
  styles,
}: {
  progress: SharedValue<number>;
  locked: boolean;
  palette: AppTheme["palette"];
  styles: AIStyles;
}) {
  const targetStyle = useAnimatedStyle(() => ({
    opacity: 0.72 + progress.value * 0.28,
    transform: [
      { translateY: (1 - progress.value) * 10 },
      { scale: 0.94 + progress.value * 0.06 },
    ],
  }));

  const fillStyle = useAnimatedStyle(() => ({
    height: 42 * Math.max(0.06, progress.value),
  }));

  const hintStyle = useAnimatedStyle(() => ({
    opacity: progress.value < 0.18 ? 0.8 : 1,
  }));

  return (
    <Animated.View pointerEvents="none" style={[styles.recordingLockTarget, targetStyle]}>
      <View style={[styles.recordingLockBubble, locked && styles.recordingLockBubbleActive]}>
        <Ionicons
          name={locked ? "lock-closed" : "lock-open"}
          size={18}
          color={locked ? palette.buttonText : palette.error}
        />
      </View>
      <View style={styles.recordingLockRail}>
        <Animated.View style={[styles.recordingLockRailFill, fillStyle]} />
      </View>
      <Ionicons name="chevron-up" size={16} color={palette.error} />
      <Animated.Text style={[styles.recordingLockHint, hintStyle]}>
        {locked ? "Locked" : "Slide up"}
      </Animated.Text>
    </Animated.View>
  );
}

export function RecordingCancelHint({
  progress,
  palette,
  styles,
}: {
  progress: SharedValue<number>;
  palette: AppTheme["palette"];
  styles: AIStyles;
}) {
  const hintStyle = useAnimatedStyle(() => ({
    opacity: 0.68 + progress.value * 0.32,
    transform: [{ translateX: -progress.value * 10 }],
  }));

  return (
    <Animated.View style={[styles.recordingCancelHint, hintStyle]}>
      <Ionicons name="chevron-back" size={13} color={palette.error} />
      <Text style={styles.recordingCancelHintText}>Slide left to cancel</Text>
    </Animated.View>
  );
}

export function SearchResultsDisclosure({
  expanded,
  foods,
  styles,
}: {
  expanded: boolean;
  foods: SearchResultFood[];
  styles: AIStyles;
}) {
  const [contentHeight, setContentHeight] = useState(0);
  const progress = useSharedValue(expanded ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(expanded ? 1 : 0, {
      duration: 180,
      easing: Easing.out(Easing.cubic),
    });
  }, [expanded, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: (contentHeight + 10) * progress.value,
    opacity: progress.value,
  }));

  return (
    <Animated.View pointerEvents={expanded ? "auto" : "none"} style={[styles.searchResultsClip, animatedStyle]}>
      <View
        style={styles.searchResults}
        onLayout={(event) => {
          setContentHeight(event.nativeEvent.layout.height);
        }}
      >
        {foods.slice(0, 6).map((food) => (
          <View key={food.resultId} style={styles.searchResultRow}>
            <Text style={styles.searchResultName}>
              {food.name}
              {food.brand ? ` • ${food.brand}` : ""}
            </Text>
            <View style={styles.searchResultMetaRow}>
              <Text style={styles.sourceBadge}>{food.sourceLabel}</Text>
              <Text style={styles.searchResultMeta}>{food.resultId}</Text>
              {food.nutrition?.calories !== undefined ? (
                <Text style={styles.searchResultMeta}>{formatCalories(food.nutrition.calories)} kcal</Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </Animated.View>
  );
}
