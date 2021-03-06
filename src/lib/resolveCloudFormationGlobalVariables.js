"use strict";

const BPromise = require("bluebird"),
  _ = require("lodash");
const chalk = require("chalk");

function listExports(AWS, exports, nextToken) {
  exports = exports || [];
  return AWS.request("CloudFormation", "listExports", { NextToken: nextToken })
    .tap((response) => {
      exports.push.apply(exports, response.Exports);
      if (response.NextToken) {
        // Query next page
        return listExports(AWS, exports, response.NextToken);
      }
    })
    .return(exports);
}

function listStackResources(AWS, resources, nextToken) {
  resources = resources || [];
  return AWS.request("CloudFormation", "listStackResources", {
    StackName: AWS.naming.getStackName(),
    NextToken: nextToken,
  })
    .then((response) => {
      resources.push.apply(resources, response.StackResourceSummaries);
      if (response.NextToken) {
        // Query next page
        return listStackResources(AWS, resources, response.NextToken);
      }
    })
    .catch((e) => {
      if (
        e.message ===
        `Stack with id ${AWS.naming.getStackName()} does not exist`
      ) {
        console.warn(
          chalk`{yellow {bold WARNNING: Failed to retrieve Stack Resources of this stack from Cloudformation.}}`
        );
        console.warn(
          chalk`{yellow {bold If this stack has not been created before, you need to deploy again to make sure the Outputs of this stack gets injected into this and other depended stacks. }}`
        );
      } else throw e;
    })
    .return(resources);
}

/**
 * Resolves CloudFormation references and import variables
 *
 * @param {Serverless} serverless - Serverless Instance
 * @param {Object[]} globalVars - Global Variables
 * @returns {Promise<String[]>} Resolves with the list of global variables
 */
function resolveCloudFormationGlobalVars(serverless, globalVars) {
  const AWS = serverless.providers.aws;
  return BPromise.join(listStackResources(AWS), listExports(AWS)).spread(
    (resources, exports) => {
      function mapValue(value) {
        if (_.isObject(value)) {
          if (value.Ref) {
            if (value.Ref === "AWS::Region") {
              return AWS.getRegion();
            } else if (value.Ref === "AWS::AccountId") {
              return AWS.getAccountId();
            } else if (value.Ref === "AWS::StackId") {
              return _.get(_.first(resources), "StackId");
            } else if (value.Ref === "AWS::StackName") {
              return AWS.naming.getStackName();
            } else {
              const resource = _.find(resources, [
                "LogicalResourceId",
                value.Ref,
              ]);
              const resolved = _.get(resource, "PhysicalResourceId", null);
              if (_.isNil(resolved)) {
                serverless.cli.log(
                  `WARNING: Failed to resolve reference ${value.Ref}`
                );
              }
              return BPromise.resolve(resolved);
            }
          } else if (value["Fn::ImportValue"]) {
            const importKey = value["Fn::ImportValue"];
            const resource = _.find(exports, ["Name", importKey]);
            const resolved = _.get(resource, "Value", null);
            if (_.isNil(resolved)) {
              serverless.cli.log(
                `WARNING: Failed to resolve import value ${importKey}`
              );
            }
            return BPromise.resolve(resolved);
          } else if (value["Fn::Join"]) {
            // Join has two Arguments. first the delimiter and second the values
            const delimiter = value["Fn::Join"][0];
            const parts = value["Fn::Join"][1];
            return BPromise.map(parts, (v) =>
              mapValue(v)
            ).then((resolvedParts) => _.join(resolvedParts, delimiter));
          }
        }

        return BPromise.resolve(value);
      }

      return BPromise.reduce(
        _.keys(globalVars),
        (result, key) => {
          return BPromise.resolve(mapValue(globalVars[key])).then(
            (resolved) => {
              process.env.SLS_DEBUG &&
                serverless.cli.log(
                  `Resolved global variable ${key}: ${JSON.stringify(resolved)}`
                );
              result[key] = resolved;
              return BPromise.resolve(result);
            }
          );
        },
        {}
      );
    }
  );
}

module.exports = resolveCloudFormationGlobalVars;
