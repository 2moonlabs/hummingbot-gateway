import fs from 'fs';
import path from 'path';

import Ajv, { ValidateFunction, DefinedError } from 'ajv';
import fse from 'fs-extra';
import yaml from 'js-yaml';

import { rootPath } from '../paths';

type Configuration = { [key: string]: any };
type ConfigurationDefaults = { [namespaceId: string]: Configuration };
interface _ConfigurationNamespaceDefinition {
  configurationPath: string;
  schemaPath: string;
}
type ConfigurationNamespaceDefinition = _ConfigurationNamespaceDefinition & {
  [key: string]: string;
};
type ConfigurationNamespaceDefinitions = {
  [namespaceId: string]: ConfigurationNamespaceDefinition;
};
interface ConfigurationRoot {
  version: number;
  configurations: ConfigurationNamespaceDefinitions;
}
const NamespaceTag: string = '$namespace ';
// Schemas are always in dist/src/templates/json/
const SchemasBaseDir: string = path.join(rootPath(), 'dist/src/templates/json');

export const ConfigRootSchemaPath: string = path.join(
  SchemasBaseDir,
  'configuration-root-schema.json',
);

// Use conf directory for configs and dist/src/templates for templates
const ConfigDir: string = path.join(rootPath(), 'conf/');
const ConfigTemplatesDir: string = path.join(rootPath(), 'dist/src/templates/');

interface UnpackedConfigNamespace {
  namespace: ConfigurationNamespace;
  configPath: string;
}

export function deepCopy(srcObject: any, dstObject: any): any {
  for (const [key, value] of Object.entries(srcObject)) {
    if (srcObject[key] instanceof Array) {
      if (!dstObject[key]) dstObject[key] = [];
      deepCopy(srcObject[key], dstObject[key]);
    } else if (srcObject[key] instanceof Object) {
      if (!dstObject[key]) dstObject[key] = {};
      deepCopy(srcObject[key], dstObject[key]);
    } else if (
      typeof srcObject[key] === typeof dstObject[key] ||
      !dstObject[key]
    ) {
      dstObject[key] = value;
    }
  }
}

export function initiateWithTemplate(templateFile: string, configFile: string) {
  // Throw an error if the template file doesn't exist
  if (!fs.existsSync(templateFile)) {
    throw new Error(`Template file not found: ${templateFile}`);
  }

  // Copy the template file to the config file
  fs.copyFileSync(templateFile, configFile);
}

const ajv: Ajv = new Ajv();

export const percentRegexp = new RegExp(/^(\d+)\/(\d+)$/);

export class ConfigurationNamespace {
  /**
   * This class encapsulates a namespace under the configuration tree.
   * A namespace represents the top-level component of a configuration path.
   * e.g. if the config path is "server.certificatePath", then "server" is the
   * namespace.
   *
   * Each namespace contains a JSON schema and a YAML configuration file.
   *
   * The JSON schema specifies the properties and data types allowed within the
   * namespace. e.g. you may specify that the "server" namespace has a few
   * mandatory properties dealing with certificates and private keys. This means
   * any missing properties or any properties outsides of the JSON schema would
   * cause a failure to initialize the namespace, and also cannot be set into
   * the namespace.
   *
   * The YAML configuration file is where the actual configuration tree goes
   * to. It is automatically validated against the JSON schema at namespace
   * initiation. It is automatically saved to and validated against JSON schema
   * again at every set() call.
   *
   * Note that configuration paths may have multiple levels. What it implies
   * is those configurations are stored in nested dictionaries - aka. a tree.
   * e.g. if the config path is "ethereum.networks.mainnet.networkID", then,
   * what it means you're accessing ["networks"]["mainnet"]["networkID"] under
   * the "ethereum" namespace.
   */
  readonly #namespaceId: string;
  readonly #schemaPath: string;
  readonly #configurationPath: string;
  readonly #templatePath: string;
  readonly #validator: ValidateFunction;
  #configuration: Configuration;

  constructor(
    id: string,
    schemaPath: string,
    configurationPath: string,
    templatePath: string,
  ) {
    this.#namespaceId = id;
    this.#schemaPath = schemaPath;
    this.#configurationPath = configurationPath;
    this.#templatePath = templatePath;
    this.#configuration = {};

    // Ensure schema exists
    if (!fs.existsSync(schemaPath)) {
      throw new Error(
        `The JSON schema for namespace ${id} (${schemaPath}) does not exist.`,
      );
    }

    this.#validator = ajv.compile(
      JSON.parse(fs.readFileSync(schemaPath).toString()),
    );

    // If config file doesn't exist, initialize from template
    if (!fs.existsSync(configurationPath)) {
      try {
        initiateWithTemplate(templatePath, configurationPath);
      } catch (err) {
        throw new Error(
          `Failed to initiate configuration from template for ${id}: ${err.message}`,
        );
      }
    }

    this.loadConfig();
  }

  get id(): string {
    return this.#namespaceId;
  }

  get schemaPath(): string {
    return this.#schemaPath;
  }

  get configurationPath(): string {
    return this.#configurationPath;
  }

  get configuration(): Configuration {
    return this.#configuration;
  }

  get templatePath(): string {
    return this.#templatePath;
  }

  loadConfig() {
    try {
      const configCandidate: Configuration = yaml.load(
        fs.readFileSync(this.#configurationPath, 'utf8'),
      ) as Configuration;

      if (!this.#validator(configCandidate)) {
        try {
          // Try to merge with template file
          if (!fs.existsSync(this.#templatePath)) {
            throw new Error(`Template file not found: ${this.#templatePath}`);
          }

          const configTemplateCandidate: Configuration = yaml.load(
            fs.readFileSync(this.#templatePath, 'utf8'),
          ) as Configuration;

          deepCopy(configCandidate, configTemplateCandidate);
          if (!this.#validator(configTemplateCandidate)) {
            for (const err of this.#validator.errors as DefinedError[]) {
              if (err.keyword === 'additionalProperties') {
                throw new Error(
                  `${this.id} config file seems to be outdated/broken due to additional property "${err.params.additionalProperty}". Kindly fix manually.`,
                );
              } else {
                throw new Error(
                  `${this.id} config file seems to be outdated/broken due to "${err.keyword}" in "${err.instancePath}" - ${err.message}. Kindly fix manually.`,
                );
              }
            }
          }

          this.#configuration = configTemplateCandidate;
          this.saveConfig();
          return;
        } catch (err) {
          throw new Error(
            `Failed to validate or merge with template: ${err.message}`,
          );
        }
      }

      this.#configuration = configCandidate;
    } catch (err) {
      throw new Error(
        `Failed to load configuration for ${this.id}: ${err.message}`,
      );
    }
  }

  saveConfig() {
    fs.writeFileSync(this.#configurationPath, yaml.dump(this.#configuration));
  }

  get(configPath: string): any {
    const pathComponents: Array<string> = configPath.split('.');
    let cursor: Configuration | any = this.#configuration;

    for (const component of pathComponents) {
      cursor = cursor[component];
      if (cursor === undefined) {
        return cursor;
      }
    }

    return cursor;
  }

  set(configPath: string, value: any): void {
    const pathComponents: Array<string> = configPath.split('.');
    const configClone: Configuration = JSON.parse(
      JSON.stringify(this.#configuration),
    );
    let cursor: Configuration | any = configClone;
    let parent: Configuration = configClone;

    for (const component of pathComponents.slice(0, -1)) {
      parent = cursor;
      cursor = cursor[component];
      if (cursor === undefined) {
        parent[component] = {};
        cursor = parent[component];
      }
    }

    const lastComponent: string = pathComponents[pathComponents.length - 1];
    cursor[lastComponent] = value;

    if (!this.#validator(configClone)) {
      throw new Error(
        `Cannot set ${this.id}.${configPath} to ${value}: ` +
          'JSON schema violation.',
      );
    }

    this.#configuration = configClone;
    this.saveConfig();
  }

  delete(configPath: string): void {
    const pathComponents: Array<string> = configPath.split('.');
    const configClone: Configuration = JSON.parse(
      JSON.stringify(this.#configuration),
    );
    let cursor: Configuration | any = configClone;
    let parent: Configuration = configClone;

    // Navigate to the parent of the property we want to delete
    for (const component of pathComponents.slice(0, -1)) {
      parent = cursor;
      cursor = cursor[component];
      if (cursor === undefined) {
        return; // Property doesn't exist, nothing to delete
      }
    }

    const lastComponent: string = pathComponents[pathComponents.length - 1];

    // Delete the property
    delete cursor[lastComponent];

    // Validate the new configuration
    if (!this.#validator(configClone)) {
      throw new Error(
        `Cannot delete ${this.id}.${configPath}: JSON schema violation.`,
      );
    }

    this.#configuration = configClone;
    this.saveConfig();
  }
}

export class ConfigManagerV2 {
  /**
   * This class encapsulates the configuration tree and all the contained
   * namespaces and files for Hummingbot Gateway. It also contains a defaults
   * mechanism for modules to set default configurations under their namespaces.
   *
   * The configuration manager starts by loading the root configuration file,
   * which defines all the configuration namespaces. The root configuration file
   * has a fixed JSON schema, that only allows namespaces to be defined there.
   *
   * After the namespaces are loaded into the configuration manager during
   * initiation, the get() and set() functions will map configuration keys and
   * values to the appropriate namespaces.
   *
   * e.g. get('ethereum.networks.mainnet.networkID') will be mapped to
   *      ethereumNamespace.get('networks.mainnet.networkID')
   * e.g. set('ethereum.networks.mainnet.networkID', 1) will be mapped to
   *      ethereumNamespace.set('networks.mainnet.networkID', 1)
   *
   * File paths in the root configuration file may be defined as absolute paths
   * or relative paths. Any relative paths would be rebased to the root
   * configuration file's parent directory.
   *
   * The static function `setDefaults()` is expected to be called by gateway
   * modules, to set default configurations under their own namespaces. Default
   * configurations are used in the `get()` function if the corresponding config
   * key is not found in its configuration namespace.
   */
  readonly #namespaces: { [key: string]: ConfigurationNamespace };

  private static _instance: ConfigManagerV2;

  public static getInstance(): ConfigManagerV2 {
    if (!ConfigManagerV2._instance) {
      const rootPath = path.join(ConfigDir, 'root.yml');
      if (!fs.existsSync(rootPath)) {
        // copy from template
        fs.copyFileSync(path.join(ConfigTemplatesDir, 'root.yml'), rootPath);
      }

      const listsPath = path.join(ConfigDir, 'lists');
      if (!fs.existsSync(listsPath)) {
        // copy from template
        fse.copySync(path.join(ConfigTemplatesDir, 'lists'), listsPath);
      }

      ConfigManagerV2._instance = new ConfigManagerV2(rootPath);
    }
    return ConfigManagerV2._instance;
  }

  static defaults: ConfigurationDefaults = {};

  constructor(configRootPath: string) {
    this.#namespaces = {};
    this.loadConfigRoot(configRootPath);
  }

  static setDefaults(namespaceId: string, defaultTree: Configuration) {
    ConfigManagerV2.defaults[namespaceId] = defaultTree;
  }

  static getFromDefaults(namespaceId: string, configPath: string): any {
    if (!(namespaceId in ConfigManagerV2.defaults)) {
      return undefined;
    }

    const pathComponents: Array<string> = configPath.split('.');
    const defaultConfig: Configuration = ConfigManagerV2.defaults[namespaceId];
    let cursor: Configuration | any = defaultConfig;
    for (const pathComponent of pathComponents) {
      cursor = cursor[pathComponent];
      if (cursor === undefined) {
        return cursor;
      }
    }

    return cursor;
  }

  get namespaces(): { [key: string]: ConfigurationNamespace } {
    return this.#namespaces;
  }

  get allConfigurations(): { [key: string]: Configuration } {
    const result: { [key: string]: Configuration } = {};
    for (const [key, value] of Object.entries(this.#namespaces)) {
      result[key] = value.configuration;
    }
    return result;
  }

  getNamespace(id: string): ConfigurationNamespace | undefined {
    return this.#namespaces[id];
  }

  addNamespace(
    id: string,
    schemaPath: string,
    configurationPath: string,
    templatePath: string,
  ): void {
    this.#namespaces[id] = new ConfigurationNamespace(
      id,
      schemaPath,
      configurationPath,
      templatePath,
    );
  }

  unpackFullConfigPath(fullConfigPath: string): UnpackedConfigNamespace {
    const pathComponents: Array<string> = fullConfigPath.split('.');
    if (pathComponents.length < 2) {
      throw new Error('Configuration paths must have at least two components.');
    }

    const namespaceComponent: string = pathComponents[0];
    const namespace: ConfigurationNamespace | undefined =
      this.#namespaces[namespaceComponent];
    if (namespace === undefined) {
      throw new Error(
        `The configuration namespace ${namespaceComponent} does not exist.`,
      );
    }

    const configPath: string = pathComponents.slice(1).join('.');
    return {
      namespace,
      configPath,
    };
  }

  get(fullConfigPath: string): any {
    const { namespace, configPath } = this.unpackFullConfigPath(fullConfigPath);
    const configValue: any = namespace.get(configPath);
    if (configValue === undefined) {
      return ConfigManagerV2.getFromDefaults(namespace.id, configPath);
    }
    return configValue;
  }

  set(fullConfigPath: string, value: any) {
    const { namespace, configPath } = this.unpackFullConfigPath(fullConfigPath);
    namespace.set(configPath, value);
  }

  delete(fullConfigPath: string) {
    const { namespace, configPath } = this.unpackFullConfigPath(fullConfigPath);
    namespace.delete(configPath);
  }

  loadConfigRoot(configRootPath: string) {
    // Load the config root file.
    const configRootFullPath: string = fs.realpathSync(configRootPath);
    const configRootDir: string = path.dirname(configRootFullPath);
    const configRoot: ConfigurationRoot = yaml.load(
      fs.readFileSync(configRootFullPath, 'utf8'),
    ) as ConfigurationRoot;

    // Validate the config root file.
    const validator: ValidateFunction = ajv.compile(
      JSON.parse(fs.readFileSync(ConfigRootSchemaPath).toString()),
    );
    if (!validator(configRoot)) {
      throw new Error('Configuration root file is invalid.');
    }

    // Extract the namespace ids.
    const namespaceMap: ConfigurationNamespaceDefinitions = {};
    for (const namespaceKey of Object.keys(configRoot.configurations)) {
      namespaceMap[namespaceKey.slice(NamespaceTag.length)] =
        configRoot.configurations[namespaceKey];
    }

    // Rebase the file paths in config & template roots if they're relative paths.
    for (const namespaceDefinition of Object.values(namespaceMap)) {
      for (const [key, filePath] of Object.entries(namespaceDefinition)) {
        if (!path.isAbsolute(filePath)) {
          if (key === 'configurationPath') {
            namespaceDefinition['templatePath'] = path.join(
              ConfigTemplatesDir,
              filePath,
            );
            namespaceDefinition[key] = path.join(configRootDir, filePath);
          } else if (key === 'schemaPath') {
            // Schemas are always in dist/src/templates/json/
            namespaceDefinition[key] = path.join(SchemasBaseDir, filePath);
          }
        } else {
          throw new Error(`Absolute path not allowed for ${key}.`);
        }
      }
    }

    // Add the namespaces according to config root.
    for (const [namespaceId, namespaceDefinition] of Object.entries(
      namespaceMap,
    )) {
      this.addNamespace(
        namespaceId,
        namespaceDefinition.schemaPath,
        namespaceDefinition.configurationPath,
        namespaceDefinition.templatePath,
      );
    }
  }
}

export function resolveDBPath(oldPath: string): string {
  if (oldPath.charAt(0) === '/') return oldPath;
  const dbDir: string = path.join(rootPath(), 'db/');
  fse.mkdirSync(dbDir, { recursive: true });
  return path.join(dbDir, oldPath);
}
