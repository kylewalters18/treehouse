dev_name := "treehouse Dev"
dev_config := '{"productName":"treehouse Dev","identifier":"com.treehouse.app.dev"}'

# Rebuild "treehouse Dev.app" from the working tree and install it into /Applications
install-dev:
    npm run tauri build -- --bundles app --config '{{dev_config}}'
    -osascript -e 'quit app "{{dev_name}}"'
    rm -rf "/Applications/{{dev_name}}.app"
    ditto "src-tauri/target/release/bundle/macos/{{dev_name}}.app" "/Applications/{{dev_name}}.app"
    @echo "installed /Applications/{{dev_name}}.app"
