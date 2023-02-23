const { Cookie } = require("tough-cookie");

const TriggerBehavior = {
  Never: "never",
  NoHistory: "no-history",
  WhenExpired: "when-expired",
  Always: "always",
};
const defaultTriggerBehaviour = TriggerBehavior.Never;

const ResponseCookieTag = {
  name: "responseCookie",
  displayName: "Response Cookie",
  description: "Cookie from response of chained request.",
  args: [
    {
      name: "request",
      displayName: "Request",
      type: "model",
      model: "Request",
    },
    {
      name: "cookieName",
      type: "string",
      displayName: "Cookie Name",
    },
    {
      name: "triggerBehavior",
      displayName: "Trigger Behavior",
      help: "Configure when to resend the dependent request",
      type: "enum",
      defaultValue: defaultTriggerBehaviour,
      options: [
        {
          displayName: "Never",
          description: "never resend request",
          value: TriggerBehavior.Never,
        },
        {
          displayName: "No History",
          description: "resend when no responses present",
          value: TriggerBehavior.NoHistory,
        },
        {
          displayName: "When Expired",
          description: "resend when existing response has expired",
          value: TriggerBehavior.WhenExpired,
        },
        {
          displayName: "Always",
          description: "resend request when needed",
          value: TriggerBehavior.Always,
        },
      ],
    },
    {
      name: "maxAgeSeconds",
      displayName: "Max age (seconds)",
      help: "The maximum age of a response to use before it expires",
      type: "number",
      hide: (args) => {
        return (
          parseOptions(args.map((a) => a.value)).triggerBehavior !==
          TriggerBehavior.WhenExpired
        );
      },
      defaultValue: 60,
    },
  ],

  async run(context, ...args) {
    const options = parseOptions(args);
    if (!options.reqId) {
      throw new Error("No request specified");
    }

    if (!options.cookieName) {
      throw new Error("No cookie specified");
    }

    const request = await context.util.models.request.getById(options.reqId);
    if (!request) {
      throw new Error(`Could not find request ${reqId}`);
    }

    const environmentId = context.context.getEnvironmentId();
    let response = await context.util.models.response.getLatestForRequestId(
      request._id,
      environmentId
    );

    let shouldResend = checkShouldResend(response, options);
    if (shouldResend && context.renderPurpose === "send") {
      response = (await resendRequest(context, request)) || response;
    }

    if (!response) {
      log("No response found");
      throw new Error("No responses for request");
    }

    if (response.error) {
      log("Response error " + response.error);
      throw new Error("Failed to send dependent request " + response.error);
    }

    if (!response.statusCode) {
      log("Invalid status code " + response.statusCode);
      throw new Error("No successful responses for request");
    }

    const cookies = getCookies(response);
    if (!cookies.length) {
      throw new Error("No cookies set for response");
    }

    const cookie = cookies.filter((c) => c.key == options.cookieName)[0];
    if (!cookie) {
      const cookieNames = cookies.map((c) => c.key).join(", ");
      throw new Error(
        `No ${options.cookieName} cookie for response. Choices are ${cookieNames}.`
      );
    }

    return cookie.value;
  },
};

module.exports.templateTags = [
  ResponseCookieTag,
];

function parseOptions(args) {
  return {
    reqId: args[0],
    cookieName: args[1],
    triggerBehavior: (args[2] || defaultTriggerBehaviour).toLowerCase(),
    maxAgeSeconds: args[3],
  };
}

async function resendRequest(context, request) {
  const requestChain = context.context.getExtraInfo("requestChain") || [];

  // Make sure we only send the request once per render so we don't have infinite recursion
  if (requestChain.some((id) => id === request._id)) {
    log("Preventing recursive render");
    return;
  }

  log("Resending dependency");
  requestChain.push(request._id);
  return await context.network.sendRequest(request, [
    { name: "requestChain", value: requestChain },
  ]);
}

function getCookies(response) {
  return response.headers
    .filter((h) => h.name.toLowerCase() == "set-cookie")
    .map((h) => Cookie.parse(h.value));
}

function checkShouldResend(response, options) {
  switch (options.triggerBehavior) {
    case TriggerBehavior.Always:
      return true;

    case TriggerBehavior.NoHistory:
      return !response;

    case TriggerBehavior.WhenExpired:
      if (!response) {
        return true;
      } else {
        const ageSeconds = (Date.now() - response.created) / 1000;
        return ageSeconds > options.maxAgeSeconds;
      }
  }

  return false;
}

const logPrefix = `[${ResponseCookieTag.name} tag]`

function log(msg) {
  console.log(`${logPrefix} ${msg}`);
}
