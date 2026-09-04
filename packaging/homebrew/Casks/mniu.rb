cask "mniu" do
  version "0.2.0"
  # REPLACE_WITH_RELEASE_SHA256 before publishing.
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/muniu-ai/muniu/releases/download/v#{version}/Muniu_#{version}_universal.dmg",
      verified: "github.com/muniu-ai/muniu/"
  name "Muniu"
  name "木牛"
  desc "Local-first Agent OS for opportunity validation and coding work"
  homepage "https://github.com/muniu-ai/muniu"

  depends_on macos: :monterey

  app "木牛.app"

  uninstall quit: "dev.muniu.desktop"

  zap trash: [
    "~/.muniu/v2",
    "~/Library/Application Support/dev.muniu.desktop",
    "~/Library/Preferences/dev.muniu.desktop.plist",
  ]
end
