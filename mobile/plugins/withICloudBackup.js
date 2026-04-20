const fs = require("fs");
const path = require("path");
const { withDangerousMod, withEntitlementsPlist, withInfoPlist } = require("expo/config-plugins");

const CONTAINER_IDENTIFIER = "iCloud.lol.mati.caloric";
const BACKUP_MODULE_FILE_NAME = "ICloudBackupModule.m";
const PBX_FILE_REF = "A19C10A44F694DF5A0FAE801";
const PBX_BUILD_FILE = "A19C10A54F694DF5A0FAE801";
const BACKUP_MODULE_FILE_CONTENT = `#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ICloudBackupModule, NSObject)
RCT_EXTERN_METHOD(ensureBackup:(NSString *)json resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
@end
`;

const BACKUP_SWIFT_SNIPPET = `

@objc(ICloudBackupModule)
final class ICloudBackupModule: NSObject {
  private static let containerIdentifier = "iCloud.lol.mati.caloric"
  private static let legacyBackupFileName = "caloric-backup.json"
  private static let backupFileNamePrefix = "caloric-backup-"
  private static let backupFileNameSuffix = ".json"
  private static let backupIntervalMs: Int64 = 24 * 60 * 60 * 1000

  @objc
  static func requiresMainQueueSetup() -> Bool {
    false
  }

  @objc(ensureBackup:resolver:rejecter:)
  func ensureBackup(
    _ json: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .utility).async {
      do {
        let result = try Self.persistBackupIfNeeded(json)
        resolve(result)
      } catch {
        let nsError = error as NSError
        reject("ERR_ICLOUD_BACKUP_WRITE", nsError.localizedDescription, nsError)
      }
    }
  }

  private static func persistBackupIfNeeded(_ json: String) throws -> [String: Any] {
    guard FileManager.default.ubiquityIdentityToken != nil else {
      return ["status": "unavailable"]
    }

    guard let containerUrl = FileManager.default.url(
      forUbiquityContainerIdentifier: containerIdentifier
    ) else {
      return ["status": "unavailable"]
    }

    let documentsUrl = containerUrl.appendingPathComponent("Documents", isDirectory: true)
    try FileManager.default.createDirectory(
      at: documentsUrl,
      withIntermediateDirectories: true,
      attributes: nil
    )

    let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
    if let latestBackup = try latestBackup(in: documentsUrl),
       nowMs - latestBackup.timestampMs < backupIntervalMs {
      return [
        "status": "skipped",
        "path": latestBackup.url.path,
        "latestBackupAt": latestBackup.timestampMs,
      ]
    }

    let fileUrl = documentsUrl.appendingPathComponent(backupFileName(for: nowMs), isDirectory: false)
    guard let data = json.data(using: .utf8) else {
      throw NSError(
        domain: "ICloudBackupModule",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Could not encode the backup payload as UTF-8."]
      )
    }

    try coordinatedWrite(data, to: fileUrl)

    return [
      "status": "success",
      "path": fileUrl.path,
      "latestBackupAt": nowMs,
    ]
  }

  private static func coordinatedWrite(_ data: Data, to fileUrl: URL) throws {
    let coordinator = NSFileCoordinator(filePresenter: nil)
    var coordinationError: NSError?
    var writeError: Error?

    coordinator.coordinate(writingItemAt: fileUrl, options: [], error: &coordinationError) { coordinatedUrl in
      do {
        try data.write(to: coordinatedUrl, options: .atomic)
      } catch {
        writeError = error
      }
    }

    if let coordinationError {
      throw coordinationError
    }

    if let writeError {
      throw writeError
    }
  }

  private static func latestBackup(in documentsUrl: URL) throws -> (url: URL, timestampMs: Int64)? {
    let contents = try FileManager.default.contentsOfDirectory(
      at: documentsUrl,
      includingPropertiesForKeys: [.contentModificationDateKey, .creationDateKey],
      options: [.skipsHiddenFiles]
    )

    var latest: (url: URL, timestampMs: Int64)?

    for url in contents {
      let fileName = url.lastPathComponent

      if fileName == legacyBackupFileName {
        let resourceValues = try? url.resourceValues(forKeys: [.contentModificationDateKey, .creationDateKey])
        let date = resourceValues?.contentModificationDate ?? resourceValues?.creationDate
        if let date {
          updateLatestBackup(&latest, url: url, timestampMs: Int64(date.timeIntervalSince1970 * 1000))
        }
        continue
      }

      guard fileName.hasPrefix(backupFileNamePrefix), fileName.hasSuffix(backupFileNameSuffix) else {
        continue
      }

      let timestampStart = fileName.index(fileName.startIndex, offsetBy: backupFileNamePrefix.count)
      let timestampEnd = fileName.index(fileName.endIndex, offsetBy: -backupFileNameSuffix.count)
      let timestampString = String(fileName[timestampStart..<timestampEnd])

      guard let timestampMs = Int64(timestampString) else {
        continue
      }

      updateLatestBackup(&latest, url: url, timestampMs: timestampMs)
    }

    return latest
  }

  private static func updateLatestBackup(
    _ currentLatest: inout (url: URL, timestampMs: Int64)?,
    url: URL,
    timestampMs: Int64
  ) {
    if let currentLatest, timestampMs <= currentLatest.timestampMs {
      return
    }

    currentLatest = (url, timestampMs)
  }

  private static func backupFileName(for timestampMs: Int64) -> String {
    "\\(backupFileNamePrefix)\\(timestampMs)\\(backupFileNameSuffix)"
  }
}
`;

function withICloudEntitlements(config) {
  return withEntitlementsPlist(config, (config) => {
    config.modResults["com.apple.developer.icloud-container-identifiers"] = [CONTAINER_IDENTIFIER];
    config.modResults["com.apple.developer.icloud-services"] = ["CloudDocuments"];
    config.modResults["com.apple.developer.ubiquity-container-identifiers"] = [CONTAINER_IDENTIFIER];
    config.modResults["com.apple.developer.ubiquity-kvstore-identifier"] = "$(TeamIdentifierPrefix)lol.mati.caloric";
    return config;
  });
}

function withICloudInfoPlist(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.LSSupportsOpeningDocumentsInPlace = true;
    config.modResults.NSUbiquitousContainers = {
      ...(config.modResults.NSUbiquitousContainers || {}),
      [CONTAINER_IDENTIFIER]: {
        NSUbiquitousContainerIsDocumentScopePublic: true,
        NSUbiquitousContainerName: "Caloric",
        NSUbiquitousContainerSupportedFolderLevels: "Any",
      },
    };
    return config;
  });
}

function patchOnce(source, marker, addition) {
  if (source.includes(addition.trim())) {
    return source;
  }
  if (!source.includes(marker)) {
    throw new Error(`Expected to find marker: ${marker}`);
  }
  return source.replace(marker, `${marker}${addition}`);
}

function withICloudBackupNativeFiles(config) {
  return withDangerousMod(config, ["ios", async (config) => {
    const iosRoot = config.modRequest.platformProjectRoot;
    const projectName = config.modRequest.projectName;
    const modulePath = path.join(iosRoot, projectName, BACKUP_MODULE_FILE_NAME);
    fs.writeFileSync(modulePath, BACKUP_MODULE_FILE_CONTENT);

    const appDelegatePath = path.join(iosRoot, projectName, "AppDelegate.swift");
    let appDelegate = fs.readFileSync(appDelegatePath, "utf8");
    if (!appDelegate.includes("import Foundation")) {
      appDelegate = appDelegate.replace("internal import Expo", "import Foundation\ninternal import Expo");
    }
    if (!appDelegate.includes("@objc(ICloudBackupModule)")) {
      appDelegate += BACKUP_SWIFT_SNIPPET;
    }
    fs.writeFileSync(appDelegatePath, appDelegate);

    const pbxprojPath = path.join(iosRoot, `${projectName}.xcodeproj`, "project.pbxproj");
    let pbxproj = fs.readFileSync(pbxprojPath, "utf8");

    pbxproj = patchOnce(
      pbxproj,
      `/* Begin PBXBuildFile section */\n`,
      `\t\t${PBX_BUILD_FILE} /* ${BACKUP_MODULE_FILE_NAME} in Sources */ = {isa = PBXBuildFile; fileRef = ${PBX_FILE_REF} /* ${BACKUP_MODULE_FILE_NAME} */; };\n`
    );
    pbxproj = patchOnce(
      pbxproj,
      `/* Begin PBXFileReference section */\n`,
      `\t\t${PBX_FILE_REF} /* ${BACKUP_MODULE_FILE_NAME} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; name = ${BACKUP_MODULE_FILE_NAME}; path = ${projectName}/${BACKUP_MODULE_FILE_NAME}; sourceTree = "<group>"; };\n`
    );
    pbxproj = patchOnce(
      pbxproj,
      `\t\t13B07FAE1A68108700A75B9A /* ${projectName} */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\tF11748412D0307B40044C1D9 /* AppDelegate.swift */,\n`,
      `\t\t\t\t${PBX_FILE_REF} /* ${BACKUP_MODULE_FILE_NAME} */,\n`
    );
    pbxproj = patchOnce(
      pbxproj,
      `\t\t13B07F871A680F5B00A75B9A /* Sources */ = {\n\t\t\tisa = PBXSourcesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t\tF11748422D0307B40044C1D9 /* AppDelegate.swift in Sources */,\n`,
      `\t\t\t\t${PBX_BUILD_FILE} /* ${BACKUP_MODULE_FILE_NAME} in Sources */,\n`
    );

    fs.writeFileSync(pbxprojPath, pbxproj);
    return config;
  }]);
}

module.exports = function withICloudBackup(config) {
  config = withICloudEntitlements(config);
  config = withICloudInfoPlist(config);
  config = withICloudBackupNativeFiles(config);
  return config;
};
