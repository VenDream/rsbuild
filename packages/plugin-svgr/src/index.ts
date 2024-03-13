import path from 'node:path';
import {
  SVG_REGEX,
  deepmerge,
  getDistPath,
  getFilename,
  SCRIPT_REGEX,
} from '@rsbuild/shared';
import { PLUGIN_REACT_NAME } from '@rsbuild/plugin-react';
import type { RsbuildPlugin } from '@rsbuild/core';
import type { Config } from '@svgr/core';

export type SvgDefaultExport = 'component' | 'url';

export type PluginSvgrOptions = {
  /**
   * Configure SVGR options.
   * @see https://react-svgr.com/docs/options/
   */
  svgrOptions?: Config;

  /**
   * Configure the default export type of SVG files.
   * @default 'url'
   * @deprecated use `svgrOptions.exportType` instead
   */
  svgDefaultExport?: SvgDefaultExport;

  /**
   * Whether to allow the use of default import and named import at the same time.
   * @default true
   */
  mixedImport?: boolean;
};

function getSvgoDefaultConfig() {
  return {
    plugins: [
      {
        name: 'preset-default',
        params: {
          overrides: {
            // viewBox is required to resize SVGs with CSS.
            // @see https://github.com/svg/svgo/issues/1128
            removeViewBox: false,
          },
        },
      },
      'prefixIds',
    ],
  };
}

export const pluginSvgr = (options: PluginSvgrOptions = {}): RsbuildPlugin => ({
  name: 'rsbuild:svgr',

  pre: [PLUGIN_REACT_NAME],

  setup(api) {
    api.modifyBundlerChain(async (chain, { isProd, CHAIN_ID }) => {
      const config = api.getNormalizedConfig();
      const { svgDefaultExport = 'url', mixedImport = true } = options;
      const distDir = getDistPath(config, 'svg');
      const filename = getFilename(config, 'svg', isProd);
      const outputName = path.posix.join(distDir, filename);
      const { dataUriLimit } = config.output;
      const maxSize =
        typeof dataUriLimit === 'number' ? dataUriLimit : dataUriLimit.svg;

      // delete Rsbuild builtin SVG rules
      chain.module.rules.delete(CHAIN_ID.RULE.SVG);

      const rule = chain.module.rule(CHAIN_ID.RULE.SVG).test(SVG_REGEX);

      const svgrOptions = deepmerge(
        {
          svgo: true,
          svgoConfig: getSvgoDefaultConfig(),
        },
        options.svgrOptions || {},
      );

      // force to url: "foo.svg?url",
      rule
        .oneOf(CHAIN_ID.ONE_OF.SVG_URL)
        .type('asset/resource')
        .resourceQuery(/(__inline=false|url)/)
        .set('generator', {
          filename: outputName,
        });

      // force to inline: "foo.svg?inline"
      rule
        .oneOf(CHAIN_ID.ONE_OF.SVG_INLINE)
        .type('asset/inline')
        .resourceQuery(/inline/);

      // force to react component: "foo.svg?react"
      rule
        .oneOf(CHAIN_ID.ONE_OF.SVG_REACT)
        .type('javascript/auto')
        .resourceQuery(/react/)
        .use(CHAIN_ID.USE.SVGR)
        .loader(path.resolve(__dirname, './loader'))
        .options({
          ...svgrOptions,
          exportType: 'default',
        } satisfies Config)
        .end();

      const exportType =
        svgrOptions.exportType ??
        (svgDefaultExport === 'url' ? 'named' : 'default');

      // SVG in JS files
      if (mixedImport || exportType === 'default') {
        rule
          .oneOf(CHAIN_ID.ONE_OF.SVG)
          .type('javascript/auto')
          .set(
            'issuer',
            // The issuer option ensures that SVGR will only apply if the SVG is imported from a JS file.
            [SCRIPT_REGEX],
          )
          .use(CHAIN_ID.USE.SVGR)
          .loader(path.resolve(__dirname, './loader'))
          .options({
            ...svgrOptions,
            exportType,
          })
          .end()
          .when(exportType === 'named', (c) =>
            c
              .use(CHAIN_ID.USE.URL)
              .loader(path.join(__dirname, '../compiled', 'url-loader'))
              .options({
                limit: maxSize,
                name: outputName,
              }),
          );
      }

      // SVG as assets
      rule
        .oneOf(CHAIN_ID.ONE_OF.SVG_ASSET)
        .type('asset')
        .parser({
          // Inline SVG if size < maxSize
          dataUrlCondition: {
            maxSize,
          },
        })
        .set('generator', {
          filename: outputName,
        });

      // apply current JS transform rule to SVGR rules
      const jsRule = chain.module.rules.get(CHAIN_ID.RULE.JS);

      [CHAIN_ID.USE.SWC, CHAIN_ID.USE.BABEL].some((jsUseId) => {
        const use = jsRule.uses.get(jsUseId);

        if (!use) {
          return false;
        }

        [CHAIN_ID.ONE_OF.SVG, CHAIN_ID.ONE_OF.SVG_REACT].forEach((oneOfId) => {
          if (!rule.oneOfs.has(oneOfId)) {
            return;
          }

          rule
            .oneOf(oneOfId)
            .use(jsUseId)
            .before(CHAIN_ID.USE.SVGR)
            .loader(use.get('loader'))
            .options(use.get('options'));
        });

        return true;
      });
    });
  },
});
