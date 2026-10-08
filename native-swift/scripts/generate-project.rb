#!/usr/bin/env ruby
require 'xcodeproj'
require 'fileutils'

root = File.expand_path('..', __dir__)
project_path = File.join(root, 'CaloricSwift.xcodeproj')
project = Xcodeproj::Project.new(project_path)
project.root_object.attributes['LastUpgradeCheck'] = '2660'
app = project.new_target(:application, 'CaloricSwift', :ios, '17.0')
sources = project.main_group.new_group('Sources', 'Sources')
Dir.glob(File.join(root, 'Sources/*.swift')).sort.each do |file|
  ref = sources.new_file(File.basename(file))
  app.source_build_phase.add_file_reference(ref)
end
resources = project.main_group.new_group('Resources', 'Resources')
Dir.glob(File.join(root, 'Resources/*')).sort.each do |file|
  ref = resources.new_file(File.basename(file))
  app.resources_build_phase.add_file_reference(ref) unless ['Info.plist', 'CaloricSwift.entitlements'].include?(File.basename(file))
end
config = project.main_group.new_group('Config', 'Config').new_file('Default.xcconfig')
app.build_configurations.each do |c|
  c.base_configuration_reference = config
  c.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER' => 'lol.mati.caloric.swift',
    'PRODUCT_NAME' => 'CaloricSwift', 'SWIFT_VERSION' => '5.0',
    'IPHONEOS_DEPLOYMENT_TARGET' => '17.0', 'TARGETED_DEVICE_FAMILY' => '1,2',
    'INFOPLIST_FILE' => 'Resources/Info.plist', 'GENERATE_INFOPLIST_FILE' => 'NO',
    'CODE_SIGN_ENTITLEMENTS' => 'Resources/CaloricSwift.entitlements',
    'CODE_SIGN_STYLE' => 'Automatic', 'ASSETCATALOG_COMPILER_APPICON_NAME' => 'AppIcon',
    'MARKETING_VERSION' => '1.0.0', 'CURRENT_PROJECT_VERSION' => '14',
    'ENABLE_USER_SCRIPT_SANDBOXING' => 'YES',
    'SWIFT_EMIT_LOC_STRINGS' => 'YES', 'SUPPORTS_MACCATALYST' => 'NO',
    'LD_RUNPATH_SEARCH_PATHS' => '$(inherited) @executable_path/Frameworks',
  })
  if c.name == 'Release'
    c.build_settings.merge!({
      'CODE_SIGN_STYLE[sdk=iphoneos*]' => 'Manual',
      'CODE_SIGN_IDENTITY[sdk=iphoneos*]' => '$(CALORIC_SIGNING_IDENTITY)',
      'PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]' => '$(CALORIC_APP_PROFILE_UUID)',
    })
  end
end
app.add_system_library('sqlite3')

widget = project.new_target(:app_extension, 'CaloricWidget', :ios, '17.0')
widget_group = project.main_group.new_group('Widget', 'Widget')
widget.source_build_phase.add_file_reference(widget_group.new_file('CaloricWidget.swift'))
widget.source_build_phase.add_file_reference(sources.files.find { |file| file.path == 'BrandPalette.swift' })
widget_group.new_file('Info.plist')
widget_group.new_file('CaloricWidget.entitlements')
widget.build_configurations.each do |c|
  c.base_configuration_reference = config
  c.build_settings.merge!({'SWIFT_VERSION' => '5.0', 'PRODUCT_BUNDLE_IDENTIFIER' => 'lol.mati.caloric.swift.CaloricWidget',
    'GENERATE_INFOPLIST_FILE' => 'NO', 'INFOPLIST_FILE' => 'Widget/Info.plist',
    'CODE_SIGN_ENTITLEMENTS' => 'Widget/CaloricWidget.entitlements', 'CODE_SIGN_STYLE' => 'Automatic',
    'TARGETED_DEVICE_FAMILY' => '1,2', 'APPLICATION_EXTENSION_API_ONLY' => 'YES',
    'SKIP_INSTALL' => 'YES', 'MARKETING_VERSION' => '1.0.0', 'CURRENT_PROJECT_VERSION' => '14'})
  if c.name == 'Release'
    c.build_settings.merge!({
      'CODE_SIGN_STYLE[sdk=iphoneos*]' => 'Manual',
      'CODE_SIGN_IDENTITY[sdk=iphoneos*]' => '$(CALORIC_SIGNING_IDENTITY)',
      'PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]' => '$(CALORIC_WIDGET_PROFILE_UUID)',
    })
  end
end
app.add_dependency(widget)
embed = app.new_copy_files_build_phase('Embed App Extensions')
embed.dst_subfolder_spec = '13'
embed.add_file_reference(widget.product_reference).settings = {'ATTRIBUTES' => ['RemoveHeadersOnCopy']}

tests = project.new_target(:unit_test_bundle, 'CaloricSwiftTests', :ios, '17.0')
tests.add_dependency(app)
test_group = project.main_group.new_group('Tests', 'Tests')
Dir.glob(File.join(root, 'Tests/*.swift')).sort.each { |file| tests.source_build_phase.add_file_reference(test_group.new_file(File.basename(file))) }
tests.build_configurations.each do |c|
  c.build_settings.merge!({'SWIFT_VERSION' => '5.0', 'PRODUCT_BUNDLE_IDENTIFIER' => 'lol.mati.caloric.swift.tests',
                         'GENERATE_INFOPLIST_FILE' => 'YES', 'TEST_HOST' => '$(BUILT_PRODUCTS_DIR)/CaloricSwift.app/CaloricSwift',
                         'BUNDLE_LOADER' => '$(TEST_HOST)', 'TARGETED_DEVICE_FAMILY' => '1,2'})
end
ui_tests = project.new_target(:ui_test_bundle, 'CaloricSwiftUITests', :ios, '17.0')
ui_tests.add_dependency(app)
ui_group = project.main_group.new_group('UITests', 'UITests')
Dir.glob(File.join(root, 'UITests/*.swift')).sort.each { |file| ui_tests.source_build_phase.add_file_reference(ui_group.new_file(File.basename(file))) }
ui_tests.build_configurations.each do |c|
  c.build_settings.merge!({'SWIFT_VERSION' => '5.0', 'PRODUCT_BUNDLE_IDENTIFIER' => 'lol.mati.caloric.swift.uitests',
                         'GENERATE_INFOPLIST_FILE' => 'YES', 'TEST_TARGET_NAME' => 'CaloricSwift', 'TARGETED_DEVICE_FAMILY' => '1,2'})
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.set_launch_target(app)
scheme.add_test_target(tests)
scheme.add_test_target(ui_tests)
scheme.save_as(project_path, 'CaloricSwift', true)
puts "Generated #{project_path}"
