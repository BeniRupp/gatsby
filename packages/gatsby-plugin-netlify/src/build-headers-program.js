import _ from "lodash"
import { writeFile, existsSync } from "fs-extra"
import { parse } from "path"
import kebabHash from "kebab-hash"
import { HEADER_COMMENT, IMMUTABLE_CACHING_HEADER } from "./constants"

import {
  COMMON_BUNDLES,
  SECURITY_HEADERS,
  CACHING_HEADERS,
  LINK_REGEX,
  NETLIFY_HEADERS_FILENAME,
} from "./constants"

function getHeaderName(header) {
  const matches = header.match(/^([^:]+):/)
  return matches && matches[1]
}

function validHeaders(headers) {
  if (!headers || !_.isObject(headers)) {
    return false
  }

  return _.every(
    headers,
    (headersList, path) =>
      _.isArray(headersList) &&
      _.every(
        headersList,
        header => _.isString(header) && getHeaderName(header)
      )
  )
}

function linkTemplate(assetPath, type = `script`) {
  return `Link: <${assetPath}>; rel=preload; as=${type}`
}

function pathChunkName(path) {
  const name = path === `/` ? `index` : kebabHash(path)
  return `path---${name}`
}

function createScriptHeaderGenerator(manifest, pathPrefix) {
  return script => {
    const chunk = manifest[script]

    if (!chunk) {
      return null
    }

    // convert to array if it's not already
    const chunks = _.isArray(chunk) ? chunk : [chunk]

    return chunks
      .filter(script => {
        const parsed = parse(script)
        // handle only .js, .css content is inlined already
        // and doesn't need to be pushed
        return parsed.ext === `.js`
      })
      .map(script => linkTemplate(`${pathPrefix}/${script}`))
      .join(`\n  `)
  }
}

function linkHeaders(scripts, manifest, pathPrefix) {
  return _.compact(
    scripts.map(createScriptHeaderGenerator(manifest, pathPrefix))
  )
}

function headersPath(pathPrefix, path) {
  return `${pathPrefix}${path}`
}

function preloadHeadersByPage(pages, manifest, pathPrefix) {
  let linksByPage = {}

  pages.forEach(page => {
    const scripts = [
      ...COMMON_BUNDLES,
      pathChunkName(page.path),
      page.componentChunkName,
    ]

    const pathKey = headersPath(pathPrefix, page.path)

    linksByPage[pathKey] = linkHeaders(scripts, manifest, pathPrefix)
  })

  return linksByPage
}

function defaultMerge(...headers) {
  function unionMerge(objValue, srcValue) {
    if (_.isArray(objValue)) {
      return _.union(objValue, srcValue)
    } else {
      return undefined // opt into default merge behavior
    }
  }

  return _.mergeWith({}, ...headers, unionMerge)
}

function headersMerge(userHeaders, defaultHeaders) {
  const merged = {}
  Object.keys(defaultHeaders).forEach(path => {
    if (!userHeaders[path]) {
      merged[path] = defaultHeaders[path]
      return
    }
    const headersMap = {}
    defaultHeaders[path].forEach(header => {
      headersMap[getHeaderName(header)] = header
    })
    userHeaders[path].forEach(header => {
      headersMap[getHeaderName(header)] = header // override if exists
    })
    merged[path] = Object.values(headersMap)
  })
  Object.keys(userHeaders).forEach(path => {
    if (!merged[path]) {
      merged[path] = userHeaders[path]
    }
  })
  return merged
}

function transformLink(manifest, publicFolder, pathPrefix) {
  return header =>
    header.replace(LINK_REGEX, (__, prefix, file, suffix) => {
      const hashed = manifest[file]
      if (hashed) {
        return `${prefix}${pathPrefix}${hashed}${suffix}`
      } else if (existsSync(publicFolder(file))) {
        return `${prefix}${pathPrefix}${file}${suffix}`
      } else {
        throw new Error(
          `Could not find the file specified in the Link header \`${header}\`.` +
            `The gatsby-plugin-netlify is looking for a matching file (with or without a ` +
            `webpack hash). Check the public folder and your gatsby-config.js to ensure you are ` +
            `pointing to a public file.`
        )
      }
    })
}

// Writes out headers file format, with two spaces for indentation
// https://www.netlify.com/docs/headers-and-basic-auth/
function stringifyHeaders(headers) {
  return _.reduce(
    headers,
    (text, headerList, path) => {
      const headersString = _.reduce(
        headerList,
        (accum, header) => `${accum}  ${header}\n`,
        ``
      )
      return `${text}${path}\n${headersString}`
    },
    ``
  )
}

// program methods

const validateUserOptions = pluginOptions => headers => {
  if (!validHeaders(headers)) {
    throw new Error(
      `The "headers" option to gatsby-plugin-netlify is in the wrong shape. ` +
        `You should pass in a object with string keys (representing the paths) and an array ` +
        `of strings as the value (representing the headers). ` +
        `Check your gatsby-config.js.`
    )
  }

  ;[`mergeSecurityHeaders`, `mergeLinkHeaders`, `mergeCachingHeaders`].forEach(
    mergeOption => {
      if (!_.isBoolean(pluginOptions[mergeOption])) {
        throw new Error(
          `The "${mergeOption}" option to gatsby-plugin-netlify must be a boolean. ` +
            `Check your gatsby-config.js.`
        )
      }
    }
  )

  if (!_.isFunction(pluginOptions.transformHeaders)) {
    throw new Error(
      `The "transformHeaders" option to gatsby-plugin-netlify must be a function ` +
        `that returns a array of header strings.` +
        `Check your gatsby-config.js.`
    )
  }

  return headers
}

const mapUserLinkHeaders = ({
  manifest,
  pathPrefix,
  publicFolder,
}) => headers =>
  _.mapValues(headers, headerList =>
    _.map(headerList, transformLink(manifest, publicFolder, pathPrefix))
  )

const mapUserLinkAllPageHeaders = (
  pluginData,
  { allPageHeaders }
) => headers => {
  if (!allPageHeaders) {
    return headers
  }

  const { pages, manifest, publicFolder, pathPrefix } = pluginData

  const headersList = _.map(
    allPageHeaders,
    transformLink(manifest, publicFolder, pathPrefix)
  )

  const duplicateHeadersByPage = {}
  pages.forEach(page => {
    const pathKey = headersPath(pathPrefix, page.path)
    duplicateHeadersByPage[pathKey] = headersList
  })

  return defaultMerge(headers, duplicateHeadersByPage)
}

const applyLinkHeaders = (pluginData, { mergeLinkHeaders }) => headers => {
  if (!mergeLinkHeaders) {
    return headers
  }

  const { pages, manifest, pathPrefix } = pluginData
  const perPageHeaders = preloadHeadersByPage(pages, manifest, pathPrefix)

  return defaultMerge(headers, perPageHeaders)
}

const applySecurityHeaders = ({ mergeSecurityHeaders }) => headers => {
  if (!mergeSecurityHeaders) {
    return headers
  }

  return headersMerge(headers, SECURITY_HEADERS)
}

const applyCachingHeaders = (
  pluginData,
  { mergeCachingHeaders }
) => headers => {
  if (!mergeCachingHeaders) {
    return headers
  }

  const chunks = Array.from(pluginData.pages.values()).map(
    page => page.componentChunkName
  )

  chunks.push(`pages-manifest`, `app`)

  const files = [].concat(...chunks.map(chunk => pluginData.manifest[chunk]))

  const cachingHeaders = {}

  files.forEach(file => {
    cachingHeaders[`/` + file] = [IMMUTABLE_CACHING_HEADER]
  })

  return defaultMerge(headers, cachingHeaders, CACHING_HEADERS)
}

const applyTransfromHeaders = ({ transformHeaders }) => headers =>
  _.mapValues(headers, transformHeaders)

const transformToString = headers =>
  `${HEADER_COMMENT}\n\n${stringifyHeaders(headers)}`

const writeHeadersFile = ({ publicFolder }) => contents =>
  writeFile(publicFolder(NETLIFY_HEADERS_FILENAME), contents)

export default function buildHeadersProgram(pluginData, pluginOptions) {
  return _.flow(
    validateUserOptions(pluginOptions),
    mapUserLinkHeaders(pluginData),
    applySecurityHeaders(pluginOptions),
    applyCachingHeaders(pluginData, pluginOptions),
    mapUserLinkAllPageHeaders(pluginData, pluginOptions),
    applyLinkHeaders(pluginData, pluginOptions),
    applyTransfromHeaders(pluginOptions),
    transformToString,
    writeHeadersFile(pluginData)
  )(pluginOptions.headers)
}
