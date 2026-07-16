import { Ionicons } from "@expo/vector-icons";
import { CameraView, type BarcodeScanningResult, useCameraPermissions } from "expo-camera";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default function ScanBarcodeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    meal?: string | string[];
    day?: string | string[];
    recipeId?: string | string[];
    recipeEntryId?: string | string[];
    testBarcode?: string | string[];
  }>();
  const [permission, requestPermission] = useCameraPermissions();
  const hasScanned = useRef(false);

  const close = () => router.back();
  const handleScan = useCallback(({ data, type }: BarcodeScanningResult) => {
    if (hasScanned.current) return;
    let barcode = data.replace(/\D/g, "");
    if (type === "upc_a" && barcode.length === 12) barcode = `0${barcode}`;
    if (!/^\d{8}$|^\d{13}$/.test(barcode)) return;

    hasScanned.current = true;
    router.dismissTo({
      pathname: "/log-food",
      params: {
        meal: first(params.meal),
        day: first(params.day),
        barcode,
        recipeId: first(params.recipeId),
        recipeEntryId: first(params.recipeEntryId),
      },
    });
  }, [params.day, params.meal, params.recipeEntryId, params.recipeId, router]);

  useEffect(() => {
    const testBarcode = first(params.testBarcode);
    if (!__DEV__ || !testBarcode) return;

    handleScan({ data: testBarcode, type: "ean13" });
  }, [handleScan, params.testBarcode]);

  if (!permission) {
    return <View style={styles.screen} />;
  }

  if (!permission.granted) {
    return (
      <View style={[styles.permissionScreen, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
        <Ionicons name="barcode-outline" size={58} color="#2563EB" />
        <Text style={styles.permissionTitle}>Scan a food barcode</Text>
        <Text style={styles.permissionText}>Camera access is needed to read the barcode on a package.</Text>
        <Pressable accessibilityRole="button" onPress={() => void requestPermission()} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Allow camera</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={close} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "upc_a"] }}
        onBarcodeScanned={handleScan}
      />
      <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
        <Pressable accessibilityLabel="Close scanner" accessibilityRole="button" onPress={close} style={styles.closeButton}>
          <Ionicons name="close" size={26} color="#FFFFFF" />
        </Pressable>
      </View>
      <View pointerEvents="none" style={styles.overlay}>
        <View style={styles.scanFrame} />
        <Text style={styles.hint}>Hold the barcode inside the frame</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  permissionScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    backgroundColor: "#F3F4F6",
  },
  permissionTitle: { marginTop: 18, fontSize: 24, lineHeight: 30, fontWeight: "700", color: "#111827" },
  permissionText: { marginTop: 8, marginBottom: 24, textAlign: "center", fontSize: 16, lineHeight: 22, color: "#6B7280" },
  primaryButton: { width: "100%", minHeight: 50, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: "#2563EB" },
  primaryButtonText: { fontSize: 17, fontWeight: "700", color: "#FFFFFF" },
  secondaryButton: { marginTop: 10, minHeight: 44, justifyContent: "center", paddingHorizontal: 20 },
  secondaryButtonText: { fontSize: 17, color: "#2563EB" },
  topBar: { position: "absolute", top: 0, left: 0, right: 0, paddingHorizontal: 18 },
  closeButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: "rgba(0,0,0,0.55)" },
  overlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  scanFrame: { width: "82%", height: 210, borderWidth: 3, borderRadius: 18, borderColor: "#FFFFFF", backgroundColor: "transparent" },
  hint: { marginTop: 22, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, overflow: "hidden", fontSize: 16, fontWeight: "600", color: "#FFFFFF", backgroundColor: "rgba(0,0,0,0.6)" },
});
