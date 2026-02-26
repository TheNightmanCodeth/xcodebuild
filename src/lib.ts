import * as core from '@actions/core'
import * as gha_exec from '@actions/exec'
import { spawnSync } from 'child_process'
import type { SpawnSyncOptions } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import semver, { Range } from 'semver'
import type { SemVer } from 'semver'

async function mdls(path: string): Promise<SemVer | undefined | null> {
  try {
    const v = await exec('mdls', ['-raw', '-name', 'kMDItemVersion', path])
    if (core.getInput('verbosity') == 'verbose') {
      // in verbose mode all commands and outputs are printed
      // and mdls in `raw` mode does not terminate its lines
      process.stdout.write('\n')
    }
    return semver.coerce(v) ?? undefined
  } catch (e) {
    const match = path.match(/Xcode_(.*)\.app/)
    if (match?.[1]) {
      return semver.coerce(match[1])
    }
  }
}

async function xcodes(): Promise<[string, SemVer][]> {
  const paths = await (async () => {
    const output = await exec('mdfind', [
      'kMDItemCFBundleIdentifier = com.apple.dt.Xcode',
    ]).catch(() => '')
    const rv = output
      .split('\n')
      .map((path) => path.trim())
      .filter((x) => x)
    if (rv.length == 0) {
      for (const entry of fs.readdirSync('/Applications')) {
        if (!/Xcode.*\.app$/.test(entry)) continue
        rv.push(path.join('/Applications', entry))
      }
    }
    return rv
  })()

  const rv: [string, SemVer][] = []
  for (const path of paths) {
    if (!path.trim()) continue
    const v = await mdls(path)
    if (v) {
      rv.push([path, v])
    }
  }

  return rv
}

export function spawn(
  arg0: string,
  args: string[],
  options: SpawnSyncOptions = { stdio: 'inherit' }
): void {
  const { error, signal, status } = spawnSync(arg0, args, options)
  if (error) throw error
  if (signal) throw new Error(`\`${arg0}\` terminated with signal (${signal})`)
  if (status != 0) throw new Error(`\`${arg0}\` aborted (${status})`)
}

export async function xcselect(xcode?: Range, swift?: Range): Promise<SemVer> {
  if (swift) {
    return selectSwift(swift)
  } else if (xcode) {
    return selectXcode(xcode)
  }

  const gotDotSwiftVersion = dotSwiftVersion()
  if (gotDotSwiftVersion) {
    core.info(`» \`.swift-version\` » ~> ${gotDotSwiftVersion}`)
    return selectSwift(gotDotSwiftVersion)
  } else {
    // figure out the GHA image default Xcode’s version

    const devdir = await exec('xcode-select', ['--print-path'])
    const xcodePath = path.dirname(path.dirname(devdir))
    const version = await mdls(xcodePath)
    if (version) {
      return version
    } else {
      // shouldn’t happen, but this action needs to know the Xcode version
      // or we cannot function, this way we are #continuously-resilient
      return selectXcode()
    }
  }

  async function selectXcode(range?: Range): Promise<SemVer> {
    const rv = (await xcodes())
      .filter(([, v]) => (range ? semver.satisfies(v, range) : true))
      .sort((a, b) => semver.compare(a[1], b[1]))
      .pop()

    if (!rv) throw new Error(`No Xcode ~> ${range}`)

    spawn('sudo', ['xcode-select', '--switch', rv[0]])

    return rv[1]
  }

  async function selectSwift(range: Range): Promise<SemVer> {
    const rv1 = await xcodes()
    const rv2 = await Promise.all(rv1.map(swiftVersion))
    const rv3 = rv2
      .filter(([, , sv]) => semver.satisfies(sv, range))
      .sort((a, b) => semver.compare(a[1], b[1]))
      .pop()

    if (!rv3)
      throw new Error(
        `No Xcode with Swift ~> ${range} (Xcodes: ${rv1.join(
          ','
        )} (Swifts: ${rv2.join(',')})`
      )

    core.info(`» Selected Swift ${rv3[2]}`)

    spawn('sudo', ['xcode-select', '--switch', rv3[0]])

    return rv3[1]

    async function swiftVersion([DEVELOPER_DIR, xcodeVersion]: [
      string,
      SemVer
    ]): Promise<[string, SemVer, SemVer]> {
      // This command emits 'swift-driver version: ...' to stderr.
      const stdout = await exec(
        'swift',
        ['--version'],
        { DEVELOPER_DIR },
        false
      )
      const matches = stdout.match(/Swift version (.+?)\s/m)
      if (!matches || !matches[1])
        throw new Error(
          `failed to extract Swift version from Xcode ${xcodeVersion}`
        )
      const version = semver.coerce(matches[1])
      if (!version)
        throw new Error(
          `failed to parse Swift version from Xcode ${xcodeVersion}`
        )
      return [DEVELOPER_DIR, xcodeVersion, version]
    }
  }

  function dotSwiftVersion(): Range | undefined {
    if (!fs.existsSync('.swift-version')) return undefined
    const version = fs.readFileSync('.swift-version').toString().trim()
    try {
      // A .swift-version of '5.0' indicates a SemVer Range of '>=5.0.0 <5.1.0'
      return new Range('~' + version)
    } catch (error) {
      core.warning(
        `Failed to parse Swift version from .swift-version: ${error}`
      )
    }
  }
}

interface Devices {
  devices: {
    [key: string]: [
      {
        udid: string
        name: string
      }
    ]
  }
}

type DeviceType = 'watchOS' | 'tvOS' | 'iOS' | 'xrOS'
type Destination = {
  id: string
  name: string | undefined
  version: SemVer
}

interface Schemes {
  workspace?: {
    schemes: string[]
  }
  project?: {
    schemes: string[]
  }
}

export async function getSchemeFromPackage(
  workspace?: string
): Promise<string> {
  let args = ['-list', '-json']
  if (workspace) args = args.concat(['-workspace', workspace])
  const out = await exec('xcodebuild', args)
  const json = parseJSON<Schemes>(out)
  const schemes = (json?.workspace ?? json?.project)?.schemes
  if (!schemes || schemes.length == 0)
    throw new Error('Could not determine scheme')
  for (const scheme of schemes) {
    if (scheme.endsWith('-Package')) return scheme
  }
  return schemes[0]
}

function parseJSON<T>(input: string): T {
  try {
    input = input.trim()
    // works around xcodebuild sometimes outputting this string in CI conditions
    const xcodebuildSucks =
      'build session not created after 15 seconds - still waiting'
    if (input.endsWith(xcodebuildSucks)) {
      input = input.slice(0, -xcodebuildSucks.length)
    }
    return JSON.parse(input) as T
  } catch (error) {
    core.startGroup('JSON')
    core.error(input)
    core.endGroup()
    throw error
  }
}

async function destination(
  deviceType: DeviceType,
  version?: Range
): Promise<Destination | undefined> {
  const out = await exec('xcrun', [
    'simctl',
    'list',
    '--json',
    'devices',
    'available',
  ])
  const devices = parseJSON<Devices>(out).devices

  // best match
  let bm: Destination | undefined
  for (const opaqueIdentifier in devices) {
    const device = (devices[opaqueIdentifier] ?? [])[0]
    if (!device) continue
    const [type, v] = parse(opaqueIdentifier)
    if (
      v &&
      type === deviceType &&
      (!version || version.test(v)) &&
      (!bm || semver.lt(bm.version, v))
    ) {
      bm = { id: device.udid, name: device.name, version: v }
    }
  }

  return bm

  function parse(key: string): [DeviceType, SemVer?] {
    const [type, ...vv] = (key.split('.').pop() ?? '').split('-')
    const v = semver.coerce(vv.join('.'))
    return [type as DeviceType, v ?? undefined]
  }
}

async function exec(
  command: string,
  args?: string[],
  env?: { [key: string]: string },
  stdErrToWarning = true
): Promise<string> {
  let out = ''
  try {
    await gha_exec.exec(command, args, {
      listeners: {
        stdout: (data) => (out += data.toString()),
        stderr: (data) => {
          const message = `${command}: ${'\u001b[33m'}${data.toString()}`
          if (stdErrToWarning) {
            core.warning(message)
          } else {
            core.info(message)
          }
        },
      },
      silent: verbosity() != 'verbose',
      env,
    })

    return out
  } catch (error) {
    // help debug efforts by showing what we ran if there was an error
    core.info(`» ${command} ${args ? args.join(' \\\n') : ''}`)
    throw error
  }
}

export type Verbosity = 'xcpretty' | 'xcbeautify' | 'quiet' | 'verbose'

export function verbosity(): Verbosity {
  const value = core.getInput('verbosity')
  switch (value) {
    case 'xcpretty':
    case 'xcbeautify':
    case 'quiet':
    case 'verbose':
      return value
    default:
      // backwards compatability
      if (core.getBooleanInput('quiet')) return 'quiet'

      core.warning(`invalid value for \`verbosity\` (${value})`)
      return 'xcpretty'
  }
}

export function getConfiguration(): string {
  const conf = core.getInput('configuration')
  switch (conf) {
    // both `.xcodeproj` and SwiftPM projects capitalize these
    // by default, and are case-sensitive. And for both if an
    // incorrect configuration is specified do not error, but
    // do not behave as expected instead.
    case 'debug':
      return 'Debug'
    case 'release':
      return 'Release'
    default:
      return conf
  }
}

export type Platform =
  | 'watchOS'
  | 'iOS'
  | 'iOS-simulator'
  | 'tvOS'
  | 'macOS'
  | 'mac-catalyst'
  | 'visionOS'
  | 'iphoneos'

export type Arch = 'arm64' | 'x86_64' | 'i386'

export function getAction(
  xcodeVersion: SemVer,
  platform?: Platform
): string | undefined {
  const action = core.getInput('action')
  if (
    platform == 'watchOS' &&
    actionIsTestable(action) &&
    semver.lt(xcodeVersion, '12.5.0')
  ) {
    core.notice('Setting `action=build` for Apple Watch / Xcode <12.5')
    return 'build'
  }

  return action ?? undefined
}

export function actionIsTestable(action?: string): boolean {
  return action == 'test' || action == 'build-for-testing'
}

export async function getDestination(
  xcodeVersion: SemVer,
  platform?: Platform,
  platformVersion?: Range
): Promise<string[]> {
  switch (platform) {
    case 'iOS':
    case 'tvOS':
    case 'watchOS':
    case 'visionOS': {
      const deviceType: DeviceType = platform === 'visionOS' ? 'xrOS' : platform
      const dest = await destination(deviceType, platformVersion)
      if (!dest) {
        core.error(
          `Device not found (platform: ${platform}, version: ${platformVersion})`
        )
        return []
      }
      core.info(`Selected device: ${dest.name} (${dest.version})`)
      return ['-destination', `id=${dest.id}`]
    }
    case 'macOS':
      return ['-destination', `platform=macOS`]
    case 'mac-catalyst':
      return ['-destination', `platform=macOS,variant=Mac Catalyst`]
    case 'iOS-simulator':
      return ['-destination', `generic/platform=iOS Simulator`]
    case 'iphoneos':
      return ['-destination', `generic/platform=iOS`]
    case undefined:
      if (semver.gte(xcodeVersion, '13.0.0')) {
        //FIXME should parse output from xcodebuild -showdestinations
        //NOTE `-json` doesn’t work
        // eg. the Package.swift could only allow iOS, assuming macOS is going to work OFTEN
        // but not ALWAYS
        return ['-destination', 'platform=macOS']
      } else {
        return []
      }
    default:
      throw new Error(`Invalid platform: ${platform}`)
  }
}

export function getIdentity(
  identity: string,
  platform?: Platform
): string | undefined {
  if (identity) {
    return `CODE_SIGN_IDENTITY="${identity}"`
  }

  if (platform == 'mac-catalyst') {
    // Disable code signing for Mac Catalyst unless overridden.
    core.notice('Disabling code signing for Mac Catalyst.')
    return 'CODE_SIGN_IDENTITY=-'
  }
}

// In order to avoid exposure to command line audit logging, we pass commands in
// via stdin. We allow only one command at a time in an effort to avoid injection.
function security(...args: string[]): void {
  for (const arg of args) {
    if (arg.includes('\n')) throw new Error('Invalid security argument')
  }

  const command = args.join(' ').concat('\n')
  spawn('/usr/bin/security', ['-i'], { input: command })
}

export async function createKeychain(
  certificate: string,
  passphrase: string
): Promise<void> {
  // The user should have already stored these as encrypted secrets, but we'll be paranoid on their behalf.
  core.setSecret(certificate)
  core.setSecret(passphrase)

  // Avoid using a well-known password.
  const password = (await exec('/usr/bin/uuidgen')).trim()
  core.setSecret(password)

  // Avoid using well-known paths.
  const name = (await exec('/usr/bin/uuidgen')).trim()
  core.setSecret(name)

  // Unfortunately, a keychain must be stored on disk. We remove it in a post action that calls deleteKeychain.
  const keychainPath = `${process.env.RUNNER_TEMP}/${name}.keychain-db`
  core.saveState('keychainPath', keychainPath)

  const keychainSearchPath = (
    await exec('/usr/bin/security', ['list-keychains', '-d', 'user'])
  )
    .split('\n')
    .map((value) => value.trim())

  core.saveState('keychainSearchPath', keychainSearchPath)

  core.info('Creating keychain')
  security('create-keychain', '-p', password, keychainPath)
  security('set-keychain-settings', '-lut', '21600', keychainPath)
  security('unlock-keychain', '-p', password, keychainPath)

  // Unfortunately, a certificate must be stored on disk in order to be imported. We remove it immediately after import.
  core.info('Importing certificate to keychain')
  const certificatePath = `${process.env.RUNNER_TEMP}/${name}.p12`
  fs.writeFileSync(certificatePath, certificate, { encoding: 'base64' })
  try {
    security(
      'import',
      certificatePath,
      '-P',
      passphrase,
      '-A',
      '-t',
      'cert',
      '-f',
      'pkcs12',
      '-x',
      '-k',
      keychainPath
    )
  } finally {
    fs.unlinkSync(certificatePath)
  }

  core.info('Updating keychain search path')
  security(
    'list-keychains',
    '-d',
    'user',
    '-s',
    keychainPath,
    ...keychainSearchPath
  )
}

export function deleteKeychain(): void {
  const state = core.getState('keychainSearchPath')
  if (state) {
    const keychainSearchPath: string[] = JSON.parse(state)
    core.info('Restoring keychain search path')
    try {
      security('list-keychains', '-d', 'user', '-s', ...keychainSearchPath)
    } catch (error) {
      core.error('Failed to restore keychain search path: ' + error)
      // Continue cleaning up.
    }
  }

  const keychainPath = core.getState('keychainPath')
  if (keychainPath) {
    core.info('Deleting keychain')
    try {
      security('delete-keychain', keychainPath)
    } catch (error) {
      core.error('Failed to delete keychain: ' + error)
      // Best we can do is deleting the keychain file.
      if (fs.existsSync(keychainPath)) {
        fs.unlinkSync(keychainPath)
      }
    }
  }
}

export async function createAppStoreConnectApiKeyFile(
  key: string
): Promise<string> {
  // Avoid using a well-known path.
  const name = (await exec('/usr/bin/uuidgen')).trim()
  core.setSecret(name)

  // Unfortunately, the key must be stored on disk. We remove it in
  // a post action that calls deleteAppStoreConnectApiKeyFile.
  const keyPath = `${process.env.RUNNER_TEMP}/${name}.p8`
  core.saveState('keyPath', keyPath)
  core.info('Creating App Store Connect API key file')
  fs.writeFileSync(keyPath, key, { encoding: 'base64' })

  return keyPath
}

export async function createCertificateViaApi(
  keyPath: string,
  keyId: string,
  keyIssuerId: string
): Promise<void> {
  // Ensure keychain exists
  if (!core.getState('keychainPath')) {
    await createKeychainForApi()
  }

  // Generate unique identifier for this certificate
  const uniqueId = (await exec('/usr/bin/uuidgen')).trim()
  core.setSecret(uniqueId)
  core.saveState('certificateUniqueId', uniqueId)

  core.info('Creating certificate via App Store Connect API')

  // Generate private key
  const privateKeyPath = `${process.env.RUNNER_TEMP}/${uniqueId}.key`
  spawn('openssl', ['genrsa', '-out', privateKeyPath, '2048'])

  try {
    // Generate CSR with unique identifier in CN
    const csrPath = `${process.env.RUNNER_TEMP}/${uniqueId}.csr`
    spawn('openssl', [
      'req',
      '-new',
      '-key',
      privateKeyPath,
      '-out',
      csrPath,
      '-subj',
      `/CN=GHA-${uniqueId}/O=GitHub Actions/C=US`,
    ])

    // Read and encode CSR
    const csrContent = fs
      .readFileSync(csrPath, 'utf8')
      .replace(/-----BEGIN CERTIFICATE REQUEST-----/, '')
      .replace(/-----END CERTIFICATE REQUEST-----/, '')
      .replace(/\n/g, '')

    // Generate JWT token
    const token = generateJwtToken(keyPath, keyId, keyIssuerId)

    // Create certificate via API
    const requestBody = JSON.stringify({
      data: {
        type: 'certificates',
        attributes: {
          csrContent,
          certificateType: 'DEVELOPMENT',
        },
      },
    })

    const createResult = spawnSync('curl', [
      '-s',
      '-X',
      'POST',
      'https://api.appstoreconnect.apple.com/v1/certificates',
      '-H',
      `Authorization: Bearer ${token}`,
      '-H',
      'Content-Type: application/json',
      '-d',
      requestBody,
    ])

    if (createResult.error || createResult.status !== 0) {
      throw new Error(
        `Failed to create certificate: ${createResult.stderr.toString()}`
      )
    }

    const response = JSON.parse(createResult.stdout.toString())

    if (response.errors) {
      throw new Error(
        `API error: ${JSON.stringify(response.errors[0] || response.errors)}`
      )
    }

    const certContent = response.data.attributes.certificateContent
    core.info(`Certificate created with ID: ${response.data.id}`)

    // Save certificate to file
    const certPath = `${process.env.RUNNER_TEMP}/${uniqueId}.cer`
    fs.writeFileSync(certPath, certContent, 'base64')

    // Convert to PEM
    const certPemPath = `${process.env.RUNNER_TEMP}/${uniqueId}.pem`
    spawn('openssl', [
      'x509',
      '-inform',
      'DER',
      '-in',
      certPath,
      '-out',
      certPemPath,
    ])

    // Create PKCS12 bundle
    const p12Path = `${process.env.RUNNER_TEMP}/${uniqueId}.p12`
    const p12Password = (await exec('/usr/bin/uuidgen')).trim()
    core.setSecret(p12Password)

    spawn('openssl', [
      'pkcs12',
      '-export',
      '-out',
      p12Path,
      '-inkey',
      privateKeyPath,
      '-in',
      certPemPath,
      '-passout',
      `pass:${p12Password}`,
    ])

    // Import to keychain
    const keychainPath = core.getState('keychainPath')
    if (keychainPath) {
      security(
        'import',
        p12Path,
        '-P',
        p12Password,
        '-A',
        '-t',
        'cert',
        '-f',
        'pkcs12',
        '-k',
        keychainPath
      )
      core.info('Certificate imported to keychain')
    }

    // Cleanup temp files
    fs.unlinkSync(csrPath)
    fs.unlinkSync(certPath)
    fs.unlinkSync(certPemPath)
    fs.unlinkSync(p12Path)
  } finally {
    fs.unlinkSync(privateKeyPath)
  }
}

async function createKeychainForApi(): Promise<void> {
  const password = (await exec('/usr/bin/uuidgen')).trim()
  core.setSecret(password)
  const name = (await exec('/usr/bin/uuidgen')).trim()
  core.setSecret(name)
  const keychainPath = `${process.env.RUNNER_TEMP}/${name}.keychain-db`
  core.saveState('keychainPath', keychainPath)

  const keychainSearchPath = (
    await exec('/usr/bin/security', ['list-keychains', '-d', 'user'])
  )
    .split('\n')
    .map((value) => value.trim())

  core.saveState('keychainSearchPath', keychainSearchPath)

  core.info('Creating keychain')
  security('create-keychain', '-p', password, keychainPath)
  security('set-keychain-settings', '-lut', '21600', keychainPath)
  security('unlock-keychain', '-p', password, keychainPath)

  core.info('Updating keychain search path')
  security(
    'list-keychains',
    '-d',
    'user',
    '-s',
    keychainPath,
    ...keychainSearchPath
  )
}

function generateJwtToken(
  keyPath: string,
  keyId: string,
  keyIssuerId: string
): string {
  const base64url = (buffer: Buffer): string => {
    return buffer
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
  }

  const header = base64url(
    Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))
  )
  const now = Math.floor(Date.now() / 1000)
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        iss: keyIssuerId,
        iat: now,
        exp: now + 1200,
        aud: 'appstoreconnect-v1',
      })
    )
  )

  const message = `${header}.${payload}`

  const signResult = spawnSync(
    'openssl',
    ['dgst', '-sha256', '-sign', keyPath],
    { input: Buffer.from(message, 'utf8') }
  )

  if (signResult.error || signResult.status !== 0) {
    throw new Error(
      `OpenSSL signing error: ${
        signResult.error || signResult.stderr.toString()
      }`
    )
  }

  const der = signResult.stdout
  let offset = 2
  offset++
  const rLength = der[offset]
  offset++
  const rBytes = der.slice(offset, offset + rLength)

  offset += rLength
  offset++
  const sLength = der[offset]
  offset++
  const sBytes = der.slice(offset, offset + sLength)

  const r =
    rBytes.length === 33 && rBytes[0] === 0
      ? rBytes.slice(1)
      : rBytes.slice(-32)
  const s =
    sBytes.length === 33 && sBytes[0] === 0
      ? sBytes.slice(1)
      : sBytes.slice(-32)

  const rawSignature = Buffer.concat([r, s])
  const signature = base64url(rawSignature)
  return `${header}.${payload}.${signature}`
}

export async function deleteAppStoreConnectApiKeyFile() {
  await deleteApiCreatedCertificates()

  const keyPath = core.getState('keyPath')
  if (keyPath && fs.existsSync(keyPath)) {
    core.info('Deleting App Store Connect API key file')
    try {
      fs.unlinkSync(keyPath)
    } catch (error) {
      core.error('Failed to delete App Store Connect API key file: ' + error)
    }
  }
}

async function deleteApiCreatedCertificates(): Promise<void> {
  const keyPath = core.getState('keyPath')
  const keyId = core.getState('apiKeyId')
  const keyIssuerId = core.getState('apiKeyIssuerId')
  const uniqueId = core.getState('certificateUniqueId')

  if (!keyPath || !keyId || !keyIssuerId) {
    core.info('No API key credentials found, skipping certificate cleanup')
    return
  }

  if (!uniqueId) {
    core.info('No certificate unique ID found, skipping certificate cleanup')
    return
  }

  try {
    const expectedCN = `GHA-${uniqueId}`
    core.info(`Looking for certificate with CN: ${expectedCN}`)

    // Find certificate in keychain by CN
    const allCerts = await exec('security', [
      'find-certificate',
      '-a',
      '-p',
      '-Z',
    ])

    const certBlocks = allCerts.split('SHA-1 hash:')
    let certHash: string | null = null
    let certPem: string | null = null

    for (const block of certBlocks) {
      const pemMatch = block.match(
        /(-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----)/m
      )
      if (!pemMatch) continue

      const pem = pemMatch[1]

      // Extract subject from certificate
      const subjectResult = spawnSync(
        'openssl',
        ['x509', '-noout', '-subject'],
        {
          input: pem,
        }
      )

      if (subjectResult.status === 0) {
        const subject = subjectResult.stdout.toString()
        if (subject.includes(`CN = ${expectedCN}`)) {
          const hashMatch = block.match(/([A-F0-9]{40})/)
          if (hashMatch) {
            certHash = hashMatch[1]
            certPem = pem
            break
          }
        }
      }
    }

    if (!certHash || !certPem) {
      core.info(`Certificate with CN ${expectedCN} not found in keychain`)
      return
    }

    core.info(`Found certificate: ${certHash}`)

    // Delete from local keychain
    await exec('security', ['delete-certificate', '-Z', certHash])
    core.info('Deleted certificate from keychain')

    // Generate JWT token
    const token = generateJwtToken(keyPath, keyId, keyIssuerId)

    // Get certificates from App Store Connect
    const listOutput = await exec('curl', [
      '-sS',
      '-w',
      '\nHTTP_CODE:%{http_code}',
      'https://api.appstoreconnect.apple.com/v1/certificates',
      '-H',
      `Authorization: Bearer ${token}`,
    ])

    const responseParts = listOutput.split('\nHTTP_CODE:')
    const responseBody = responseParts[0]
    const httpCode = responseParts[1]?.trim()

    if (httpCode !== '200') {
      core.warning(`API request failed with status ${httpCode}`)
      return
    }

    const apiResponse: {
      data?: Array<{
        id: string
        attributes: { certificateContent: string; name: string }
      }>
      errors?: Array<{ title: string; detail: string }>
    } = JSON.parse(responseBody)

    if (apiResponse.errors) {
      core.warning(`API errors: ${JSON.stringify(apiResponse.errors)}`)
      return
    }

    if (!apiResponse.data || apiResponse.data.length === 0) {
      core.warning('No certificates found in App Store Connect')
      return
    }

    core.info(
      `Found ${apiResponse.data.length} certificates in App Store Connect`
    )

    // Find matching certificate by CN in certificate content
    let matchingCert: { id: string; name: string } | null = null

    for (const cert of apiResponse.data) {
      const certContent = Buffer.from(
        cert.attributes.certificateContent,
        'base64'
      ).toString('utf8')

      const subjectResult = spawnSync(
        'openssl',
        ['x509', '-noout', '-subject'],
        {
          input: certContent,
        }
      )

      if (subjectResult.status === 0) {
        const subject = subjectResult.stdout.toString()
        if (subject.includes(`CN = ${expectedCN}`)) {
          matchingCert = { id: cert.id, name: cert.attributes.name }
          break
        }
      }
    }

    if (!matchingCert) {
      core.warning(
        `Could not find certificate with CN ${expectedCN} in App Store Connect`
      )
      return
    }

    core.info(`Revoking certificate ${matchingCert.id} (${matchingCert.name})`)

    // Revoke from App Store Connect
    await exec('curl', [
      '-sS',
      '-X',
      'DELETE',
      `https://api.appstoreconnect.apple.com/v1/certificates/${matchingCert.id}`,
      '-H',
      `Authorization: Bearer ${token}`,
    ])

    core.info('Certificate revoked from App Store Connect')
  } catch (error) {
    core.warning(`Failed to delete API-created certificate: ${error}`)
  }
}

export async function createProvisioningProfiles(
  mobileProfiles: string[],
  profiles: string[]
) {
  core.info('Creating provisioning profiles')

  for (const profile of mobileProfiles) {
    await createProvisioningProfile(profile, '.mobileprovision')
  }

  for (const profile of profiles) {
    await createProvisioningProfile(profile, '.provisionprofile')
  }
}

async function createProvisioningProfile(profile: string, extension: string) {
  // Avoid using a well-known path.
  const name = (await exec('/usr/bin/uuidgen')).trim()
  core.setSecret(name)

  const directory = path.join(
    `${process.env.HOME}`,
    'Library/MobileDevice/Provisioning Profiles'
  )
  fs.mkdirSync(directory, { recursive: true })

  const profilePath = path.join(directory, name + extension)

  // Add the new profile path to the saved state so we can delete it in post.
  const state = JSON.parse(core.getState('provisioningProfilePaths') || '[]')
  state.push(profilePath)
  core.saveState('provisioningProfilePaths', state)

  fs.writeFileSync(profilePath, profile, { encoding: 'base64' })
}

export function deleteProvisioningProfiles() {
  const state = core.getState('provisioningProfilePaths')
  if (!state) return

  core.info('Deleting provisioning profiles')
  for (const path in JSON.parse(state)) {
    if (fs.existsSync(path)) {
      try {
        fs.unlinkSync(path)
      } catch (error) {
        core.error('Failed to delete provisioning profile: ' + error)
      }
    }
  }
}
