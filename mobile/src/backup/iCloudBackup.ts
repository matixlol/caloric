import { NativeModules, Platform } from "react-native";

export type ICloudBackupEnsureResult = {
  status: "success" | "skipped" | "unavailable";
  path?: string;
  latestBackupAt?: number;
};

type ICloudBackupModuleShape = {
  ensureBackup(json: string): Promise<ICloudBackupEnsureResult>;
};

const nativeModule = NativeModules.ICloudBackupModule as ICloudBackupModuleShape | undefined;

export async function ensureICloudBackup(json: string): Promise<ICloudBackupEnsureResult> {
  if (Platform.OS !== "ios" || !nativeModule?.ensureBackup) {
    return { status: "unavailable" };
  }

  return nativeModule.ensureBackup(json);
}
