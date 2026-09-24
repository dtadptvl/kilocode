import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

async function text(file: string) {
  return readFile(path.join(root, file), "utf8")
}

function defaultRef(script: string) {
  return script.match(/\[string\]\$Ref\s*=\s*'([0-9a-f]{40})'/)?.[1]
}

test("0.2.2 bootstrap and documentation agree on the immutable payload", async () => {
  const [releaseText, packageText, install, uninstall, readme] = await Promise.all([
    text("release.json"),
    text("package.json"),
    text("install-online.ps1"),
    text("uninstall-online.ps1"),
    text("README.md"),
  ])

  const release = JSON.parse(releaseText) as { version: string; payload: string }
  const pkg = JSON.parse(packageText) as { version: string }

  expect(release.version).toBe("0.2.2")
  expect(pkg.version).toBe(release.version)
  expect(release.payload).toMatch(/^[0-9a-f]{40}$/)
  expect(defaultRef(install)).toBe(release.payload)
  expect(defaultRef(uninstall)).toBe(release.payload)
  expect(install).not.toMatch(/\[string\]\$Ref\s*=\s*'main'/)
  expect(uninstall).not.toMatch(/\[string\]\$Ref\s*=\s*'main'/)
  expect(readme).toContain(`Zero-Mem ${release.version}`)
  expect(readme).toContain(release.payload)
})
