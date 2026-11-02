// electron-builder lists its Squirrel.Windows and macOS DMG targets as required peer
// dependencies, so npm installs them (and their deprecated dependencies) even though
// RepoDeck only builds the Windows NSIS installer. package.json's "overrides" points
// both at this placeholder; it is only loaded if one of those targets is built.
throw new Error('This build target is not set up for RepoDeck. Only the Windows NSIS installer is (npm run dist). '
  + 'To build Squirrel.Windows or a macOS DMG, remove the matching entry from "overrides" in package.json.');
