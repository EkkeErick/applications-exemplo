"use strict";
require("dotenv").config();
var dcrLog = require("debug")("tpp:dcr"),
  paymentLog = require("debug")("tpp:payment"),
  setupLog = require("debug")("tpp:setup"),
  consentLog = require("debug")("tpp:consent"),
  commsLog = require("debug")("tpp:communications");
const configuration = require("./config");

//deep copy configuration object
let config = JSON.parse(JSON.stringify(configuration));

(async () => {
  const {
    TokenSet,
    Issuer,
    custom,
    generators /*, TokenSet */,
  } = require("openid-client");
  const fs = require("fs");
  const crypto = require("crypto");
  const express = require("express");
  const cookieParser = require("cookie-parser");
  const app = express();
  const path = require("path");
  const https = require("https");
  const { default: axios } = require("axios");
  const certsPath = path.join(__dirname, "./certs/");
  const jose = require("jose");
  const { nanoid } = require("nanoid");
  const cors = require("cors");
  const session = require("express-session");
  const MongoDBStore = require("connect-mongodb-session")(session);
  const { connectToDb, getDb } = require("./db");
  const uploadFile = require("express-fileupload");

  app.use(cors({ credentials: true, origin: "https://tpp.localhost:8080" }));

  //A lot of oauth 2 bodies are form url encoded
  app.use(express.urlencoded({ extended: true }));

  // configure MongoDB store for sessions
  const store = new MongoDBStore({
    uri: "mongodb://localhost:27017/MockTPP",
    collection: "sessions",
  });

  // connct to mongoDB
  let db;
  connectToDb((error) => {
    if(!error){
      db = getDb();

      https
      .createServer(
        {
          // ...
          key: fs.readFileSync(certsPath + "transport.key"),
          cert: fs.readFileSync(certsPath + "transport.pem"),
          // ...
        },
        app
      )
      .listen(443);
  
      console.log("Node.js web server at port 443 is running..");

    } else {
      throw new Error("Failed to connect to the mongoDB database");
    }
  });

  //secret should be a lnog string value in production
  app.use(
    session({
      secret: "boo",
      resave: false,
      saveUninitialized: false,
      cookie: { secure: true, sameSite: "none", httpOnly: false },
      store: store,
    })
  );

  // parse various different custom JSON types as JSON
  app.use(express.json({ type: "application/json" }));

  /*fapiClient object should be stored in a session db because object with methods cannot be stored in memory session,
  but for now we use an array to store the fapiClients with associated session IDs*/
  const fapiClientSpecificData = [];

  function getCerts(certificates = {}){

    const certAuthority = certificates.hasOwnProperty(
      "ca.pem"
    )
      ? certificates["ca.pem"]
      : fs.readFileSync(certsPath + "ca.pem");

    const transportKey = certificates.hasOwnProperty(
      "transport.key"
    )
      ? certificates["transport.key"]
      : fs.readFileSync(certsPath + "transport.key");

    const transportPem = certificates.hasOwnProperty(
      "transport.pem"
    )
      ? certificates["transport.pem"]
      : fs.readFileSync(certsPath + "transport.pem");

    const signingKey = certificates.hasOwnProperty(
      "signing.key"
    )
      ? certificates["signing.key"]
      : fs.readFileSync(certsPath + "signing.key");

      return {certAuthority, transportKey, transportPem, signingKey};
  }

  function getPrivateKey(signingKey){
    const key = crypto.createPrivateKey(signingKey);
    return key;
  }

  async function initConfig(req, res, flag = "") {

    const {certAuthority, transportKey, transportPem, signingKey} =  getCerts(req.session.certificates);


    //We need to confirm our private key into a jwks for local signing
    const key = getPrivateKey(signingKey);
    req.session.privateJwk = await jose.exportJWK(key);
    req.session.privateJwk.kid = req.session.config
      ? req.session.config.data.signing_kid
      : config.data.signing_kid;
    setupLog("Create private jwk key %O", req.session.privateJwk);
    req.session.keyset = {
      keys: [req.session.privateJwk],
    };

    //We need to setup an mtls certificate httpsAgent
    //NOTE: Do NOT leave rejectUnauthorized as 'false' as this disables certificate chain verification
    const httpsAgent = new https.Agent({
      ca: certAuthority,
      key: transportKey,
      cert: transportPem,
      rejectUnauthorized: false,
    });

    //Set some logging options so that we log evrey request and response in an easy to use pattern
    req.session.loggingOptions = {
      hooks: {
        beforeRequest: [
          (options) => {
            commsLog(
              "--> %s %s",
              options.method.toUpperCase(),
              options.url.href
            );
            commsLog("--> HEADERS %o", options.headers);
            if (options.body) {
              commsLog("--> BODY %s", options.body);
            }
            if (options.form) {
              commsLog("--> FORM %s", options.form);
            }
          },
        ],
        afterResponse: [
          (response) => {
            commsLog(
              "<-- %i FROM %s %s",
              response.statusCode,
              response.request.options.method.toUpperCase(),
              response.request.options.url.href
            );
            commsLog("<-- HEADERS %o", response.headers);
            if (response.body) {
              commsLog("<-- BODY %s", response.body);
            }
            return response;
          },
        ],
      },
      timeout: 20000,
      https: {
        certificateAuthority: certAuthority,
        certificate: transportPem,
        key: transportKey,
        rejectUnauthorized: false,
      },
    };
    custom.setHttpOptionsDefaults(req.session.loggingOptions);

    //Retrieve the information from the open banking brazil directory of participants on launch
    req.session.instance = axios.create({ httpsAgent });
    setupLog("Retrieving Banks from Directory of Participants");
    const axiosResponse = await req.session.instance.get(
      "https://data.sandbox.directory.openbankingbrasil.org.br/participants"
    );

    req.session.axiosResponse = axiosResponse.data;

    if(flag === "CUSTOM_CERTS"){
      return;
    }

    res.send("success");
  }

  app.get("/", initConfig);

  //This configures a FAPI Client for the Bank that you have selected from the UI
  async function setupClient(
    bank,
    selectedDcrOption,
    req,
    clientId = "",
    registrationAccessToken = ""
  ) {
    const useCustomConfig = req.session.useCustomConfig;
    //Use the default config if no custom configuration is provided
    if (!useCustomConfig) {
      req.session.config = JSON.parse(JSON.stringify(configuration));
    } else {
      req.session.config = JSON.parse(JSON.stringify(req.session.customConfig));
    }
    setupLog("Begin Client Setup for Target Bank");
    req.session.selectedOrganisation = req.session.availableBanks.find(
      (server) => {
        if (
          server.AuthorisationServers &&
          server.AuthorisationServers.some((as) => {
            if (as.CustomerFriendlyName == bank) {
              req.session.selectedAuthServer = as;
              setupLog("Target bank found in authorisation servers list");
              setupLog(req.session.selectedAuthServer);
              return true;
            }
          })
        ) {
          return server;
        }
      }
    );

    //Find the openid server configuration for the target bank
    dcrLog("Discovering how to talk to target bank");
    const localIssuer = await Issuer.discover(
      req.session.selectedAuthServer.OpenIDDiscoveryDocument
    );

    dcrLog(
      "Discovered Target Bank Issuer Configuration %s %O",
      localIssuer.issuer,
      localIssuer.metadata
    );

    const { FAPI1Client } = localIssuer;

    const {certAuthority, transportKey, transportPem } =  getCerts(req.session.certificates);

    let fapiClient;
    if (selectedDcrOption === "USE_EXISTING_CLIENT") {
      try {
        dcrLog("Get the existing client from the Bank");
        //try and get the existing client and set the private keys
        //For the new instance
        FAPI1Client[custom.http_options] = function (url, options) {
          // see https://github.com/sindresorhus/got/tree/v11.8.0#advanced-https-api
          const result = {};

          result.cert = transportPem; // <string> | <string[]> | <Buffer> | <Buffer[]>
          result.key = transportKey;
          result.ca = certAuthority; // <string> | <string[]> | <Buffer> | <Buffer[]> | <Object[]>
          return result;
        };

        try {
          fapiClient = await FAPI1Client.fromUri(
            `https://matls-auth.mockbank.poc.raidiam.io/reg/${clientId}`,
            registrationAccessToken,
            req.session.keyset
          );
        } catch (error) {
          throw error;
        }

        dcrLog("The existing client obtained successfully");
        dcrLog(fapiClient);
        req.session.clientId = fapiClient.client_id;
        dcrLog("TODO: Save client For Later Use");
      } catch (err) {
        console.log(err);
        dcrLog("Error obtaining the existing client's deatils from the bank");
        dcrLog(err);
        throw err;
      }

      //For the new instance set the HTTPS options as well
      fapiClient[custom.http_options] = function (url, options) {
        // see https://github.com/sindresorhus/got/tree/v11.8.0#advanced-https-api
        const result = {};

        result.cert = transportPem; // <string> | <string[]> | <Buffer> | <Buffer[]>
        result.key = transportKey;
        result.ca = certAuthority; // <string> | <string[]> | <Buffer> | <Buffer[]> | <Object[]>
        return result;
      };

      setupLog("Client Setup for Target Bank Complete");
      return { fapiClient, localIssuer };
    }

    //Check if the client is registered, if it is not, register it.
    dcrLog("Check if client already registered for this target bank");
    dcrLog("Client not registered");
    dcrLog("Beginning DCR Process");
    dcrLog("Discover how to talk to the Directory of Participants");
    //Create a new FAPI Client to talk to the directory.
    const directoryIssuer = await Issuer.discover(
      "https://auth.sandbox.directory.openbankingbrasil.org.br/"
    );

    dcrLog(
      "Discovered directory issuer %s %O",
      directoryIssuer.issuer,
      directoryIssuer.metadata
    );
    const DirectoryFAPIClient = directoryIssuer.FAPI1Client;
    const directoryFapiClient = new DirectoryFAPIClient(
      req.session.config.data.client
    );
    dcrLog(
      "Create FAPI Client to talk to the directory %O",
      directoryFapiClient
    );

    //Set the mutual tls client and certificate to talk to the client.
    directoryFapiClient[custom.http_options] = function (url, options) {
      const result = {};

      result.cert = transportPem; // <string> | <string[]> | <Buffer> | <Buffer[]>
      result.key = transportKey;
      result.ca = certAuthority; // <string> | <string[]> | <Buffer> | <Buffer[]> | <Object[]>
      return result;
    };

    //Grab an access token with directory:software scope
    dcrLog("Obtaining Directory Access Token");
    const directoryTokenSet = await directoryFapiClient.grant({
      grant_type: "client_credentials",
      scope: "directory:software",
    });

    //Obtain the client ssa
    dcrLog("Obtaining SSA");
    const ssa = await directoryFapiClient.requestResource(
      `https://matls-api.sandbox.directory.openbankingbrasil.org.br/organisations/${req.session.config.data.organisation_id}/softwarestatements/${req.session.config.data.software_statement_id}/assertion`,
      directoryTokenSet
    );

    //Retrieve the keyset of the directory to validate the SSA, technically this is not required as the Bank is the party that have to validate it but it's good to show
    dcrLog("Obtaining Directory JWKS to validate the SSA");
    const JWKS = await jose.createRemoteJWKSet(
      new URL(
        "https://keystore.sandbox.directory.openbankingbrasil.org.br/openbanking.jwks"
      )
    );

    //Validate the jwt
    dcrLog("Validating SSA and extracting contents");
    const { payload } = await jose.jwtVerify(ssa.body.toString("utf-8"), JWKS, {
      //The expected issuer for production is available on the security specifications
      issuer: "Open Banking Open Banking Brasil sandbox SSA issuer",
      clockTolerance: 2,
    });
    dcrLog(payload);

    dcrLog(
      `Select how to to authenticate to the bank from Banks advertised mechanisms, ${process.env.PREFERRED_TOKEN_AUTH_MECH} is preferred`
    );
    let preferredTokenAuthMech = req.session.useCustomConfig
      ? req.session.customEnvVars.preferred_token_auth_mech
      : process.env.PREFERRED_TOKEN_AUTH_MECH;
    //base on the options that the bank supports we're going to turn some defaults on
    localIssuer.metadata.token_endpoint_auth_methods_supported.includes(
      preferredTokenAuthMech
    )
      ? (req.session.config.data.client.token_endpoint_auth_method =
          preferredTokenAuthMech)
      : preferredTokenAuthMech == "private_key_jwt"
      ? (req.session.config.data.client.token_endpoint_auth_method =
          "tls_client_auth")
      : (req.session.config.data.client.token_endpoint_auth_method =
          "private_key_jwt");
    dcrLog(
      "Mechanism selected based on what bank supports %O",
      req.session.config.data.client.token_endpoint_auth_method
    );
    //This line will require the bank to enforce par without it the client should be free to choose PAR or standard
    localIssuer.metadata.request_uri_parameter_supported
      ? (req.session.config.data.client.require_pushed_authorization_requests = true)
      : (req.session.config.data.client.require_pushed_authorization_requests = false);
    dcrLog(
      "Use pushed authorisation requests if the bank supports it. Will use PAR? %O",
      req.session.config.data.client.require_pushed_authorization_requests
    );

    //Set the redirects as they're required as a subset of whats registered
    req.session.config.data.client.redirect_uris =
      payload.software_redirect_uris;
    dcrLog(
      "Set redirect_uris from software statement %O",
      payload.software_redirect_uris
    );

    //Add the software statement to your request for registration
    req.session.config.data.client.software_statement =
      ssa.body.toString("utf-8");
    dcrLog(
      "Set softwarestatement from directory into registration metadata %O",
      req.session.config.data.client.software_statement
    );

    //Set jwks uri from the directory as this is required outside of the SSA if the client is going to be privatekeyjwt
    req.session.config.data.client.jwks_uri = payload.software_jwks_uri;
    dcrLog(
      "Set jwks_uri from directory into registration metadata %O",
      payload.software_jwks_uri
    );

    try {
      dcrLog("Register Client at Bank");
      //try and register a new client and set the private keys
      //For the new instance
      FAPI1Client[custom.http_options] = function (url, options) {
        // see https://github.com/sindresorhus/got/tree/v11.8.0#advanced-https-api
        const result = {};

        result.cert = transportPem; // <string> | <string[]> | <Buffer> | <Buffer[]>
        result.key = transportKey;
        result.ca = certAuthority; // <string> | <string[]> | <Buffer> | <Buffer[]> | <Object[]>
        return result;
      };

      fapiClient = await FAPI1Client.register(req.session.config.data.client, {
        jwks: req.session.keyset,
      });
      dcrLog("New client created successfully");
      dcrLog(fapiClient);
      req.session.clientId = fapiClient.client_id;
      dcrLog("TODO: Save client For Later Use");
      const result = await db.collection("clients").insertOne({bank: bank, clientId: fapiClient.client_id, registrationAccessToken: fapiClient.registration_access_token});
      dcrLog("Client added to the database", result);
    } catch (err) {
      console.log(err);
      dcrLog("Error registering client at bank");
      dcrLog(err);
      throw err;
    }
    //For the new instance set the HTTPS options as well
    fapiClient[custom.http_options] = function (url, options) {
      // see https://github.com/sindresorhus/got/tree/v11.8.0#advanced-https-api
      const result = {};

      result.cert = transportPem; // <string> | <string[]> | <Buffer> | <Buffer[]>
      result.key = transportKey;
      result.ca = certAuthority; // <string> | <string[]> | <Buffer> | <Buffer[]> | <Object[]>
      return result;
    };

    setupLog("Client Setup for Target Bank Complete");
    return { fapiClient, localIssuer };
  }

  function getEndpoint(authServer, apiFamilyType, apiEndpointRegex) {
    let consentEndpoint;
    authServer.ApiResources.find((resource) => {
      if (resource.ApiFamilyType === apiFamilyType) {
        //'payments-consents'
        resource.ApiDiscoveryEndpoints.find((endpoint) => {
          if (endpoint.ApiEndpoint.match(apiEndpointRegex)) {
            //'open-banking\/payments\/v1\/consents$'
            consentEndpoint = endpoint.ApiEndpoint;
            return endpoint;
          }
        });
        return resource;
      }
    });
    return consentEndpoint;
  }

  function sleep(ms) {
    paymentLog("Sleeping");
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  //This pushes an authorization request to the banks pushed authorisation request and returns the authorisation redirect uri
  async function generateRequest(
    fapiClient,
    authServer,
    payloadData,
    flag,
    organisation,
    req
  ) {
    consentLog(
      "Beginning the generation of a consent record and authorisation process"
    );
    //Find the consent endpoint for this authorisation server
    req.session.flag = flag;
    let apiFamilyType, apiEndpointRegex;
    if (flag === "PAYMENTS") {
      consentLog(
        "Find the consent endpoint for the payments consent from the selected authorisation server from the directory"
      );
      apiFamilyType = "payments-consents";
      apiEndpointRegex = "open-banking/payments/v1/consents$";
    } else {
      consentLog(
        "Find the consent endpoint from the selected authorisation server from the directory"
      );
      apiFamilyType = "consents";
      apiEndpointRegex = "open-banking/consents/v1/consents$";
    }
    const consentEndpoint = getEndpoint(
      authServer,
      apiFamilyType,
      apiEndpointRegex
    );
    consentLog("Consent endpoint found %O", consentEndpoint);

    let theScope;
    let signedPayload;
    let requestOptions;
    if (flag === "PAYMENTS") {
      //Turn the payment consent data into a jwt
      consentLog(
        "Creating consent JWT from the previously stored payment consent details"
      );
      consentLog("Log presigning payment consent object");
      consentLog(payloadData);
      const { signingKey } =  getCerts(req.session.certificates);
      const key = getPrivateKey(signingKey);
      signedPayload = await new jose.SignJWT({ data: payloadData })
        .setProtectedHeader({
          alg: "PS256",
          typ: "JWT",
          kid: req.session.privateJwk.kid,
        })
        .setIssuedAt()
        .setIssuer(req.session.config.data.organisation_id)
        .setJti(nanoid())
        .setAudience(consentEndpoint)
        .setExpirationTime("5m")
        .sign(key);

      consentLog("Log post signing payment consent JWT");
      consentLog(signedPayload);

      theScope = "payments";
      requestOptions = {
        method: "POST",
        body: signedPayload,
        headers: {
          "content-type": "application/jwt",
          "x-idempotency-key": nanoid(),
        },
      };
    } else {
      theScope = "consents";
      requestOptions = {
        method: "POST",
        body: payloadData,
        headers: {
          "content-type": "application/json",
        },
      };
    }

    consentLog("Obtaining an access token to create the consent record");
    const ccToken = await fapiClient.grant({
      grant_type: "client_credentials",
      scope: theScope,
    });

    //Create the consent
    consentLog("Creating the consent record");
    const response = await fapiClient.requestResource(
      consentEndpoint,
      ccToken,
      requestOptions
    );
    

    let payload;
    if (flag === "PAYMENTS") {
      consentLog(
        "Validate the Consent Response JWT to confirm it was signed correctly by the bank"
      );
      consentLog(
        "Retrieve the keyset for the bank sending the consent response from the diretory of participants"
      );
      //Retrieve the keyset of the sending bank
      const JWKS = await jose.createRemoteJWKSet(
        new URL(
          `https://keystore.sandbox.directory.openbankingbrasil.org.br/${organisation.OrganisationId}/application.jwks`
        )
      );

      //Validate the jwt
      const result = await jose.jwtVerify(response.body.toString(), JWKS, {
        issuer: organisation.organisation_id,
        audience: req.session.config.data.organisation_id,
        clockTolerance: 2,
      });
      payload = result.payload;
      req.session.createdConsent = payload;
    } else {
      req.session.createdConsent = JSON.parse(response.body.toString());
    }

    if (response.statusCode != 201) {
      consentLog("Consent NOT created successfully");
      return { error: payload };
    }

    consentLog("Consent response payload validated and extracted successfully");

    consentLog(
      "Setting parameters for the authorisation flow including nonce and pkce"
    );
    const state = crypto.randomBytes(32).toString("hex");
    const nonce = crypto.randomBytes(32).toString("hex");
    const code_verifier = generators.codeVerifier();

    // store the code_verifier in your framework's session mechanism, if it is a cookie based solution
    // it should be httpOnly (not readable by javascript) and encrypted.
    const code_challenge = generators.codeChallenge(code_verifier);

    consentLog(
      "Request that the bank provide the users authentication time in the id_token, if the bank does not support this then the it should just ignore this attribute and carry on processing the request"
    );
    const claims = {
      id_token: {
        auth_time: {
          essential: true,
        },
      },
      user_info: {
        auth_time: {
          essential: true,
        },
      },
    };

    consentLog(
      "Add the created consent records id to the dynamic consent scope"
    );

    const scope =
      flag === "PAYMENTS"
        ? `openid consent:${payload.data.consentId} payments`
        : `openid consent:${
            JSON.parse(response.body.toString()).data.consentId
          } accounts resources credit-cards-accounts unarranged-accounts-overdraft customers loans financings invoice-financings`;
    consentLog("Create the FAPI request object");
    const requestObject = await fapiClient.requestObject({
      scope,
      response_type: "code id_token",
      redirect_uri: "https://tpp.localhost/cb",
      code_challenge,
      code_challenge_method: "S256",
      response_mode: "form_post",
      state,
      nonce,
      claims,
      max_age: 900,
    });

    consentLog(requestObject);

    let reference;
    let authUrl;

    //If there is a pushed authorisation request end point then use it as it is a more secure way to talk to the bank
    consentLog(
      "Decide how to communicate the request to the bank, by reference (PAR) or by Value"
    );
    if (fapiClient.issuer.pushed_authorization_request_endpoint) {
      consentLog(
        "The bank supports PAR so we will use this mechanism as it is more secure"
      );
      try {
        consentLog("Create a PAR resource");
        reference = await fapiClient.pushedAuthorizationRequest({
          request: requestObject,
        });
      } catch (e) {
        console.log(e);
      }

      consentLog("Create a authorisation request url using PAR");
      authUrl = await fapiClient.authorizationUrl({
        request_uri: reference.request_uri,
        prompt: "consent",
      });
      consentLog(authUrl);
      return {
        authUrl,
        code_verifier,
        state,
        nonce,
        createdConsent: req.session.createdConsent,
      };
    } else {
      consentLog(
        "Create a authorisation request url passing the request object by value"
      );
      authUrl = await fapiClient.authorizationUrl({
        request: requestObject,
        prompt: "consent",
      });
      consentLog(authUrl);
      return {
        authUrl,
        code_verifier,
        state,
        nonce,
        createdConsent: req.session.createdConsent,
      };
    }
  }

  //Express setup routes
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, "public")));

  app.use("/banks/:option", async (req, res) => {
    const apiFamilyType =
      req.params.option === "payments"
        ? "payments-consents"
        : "customers-personal";

    const TotalBanks = req.session.axiosResponse;
    req.session.availableBanks = TotalBanks.filter((e) =>
      e.AuthorisationServers.some((as) =>
        as.ApiResources.some(
          (apifamily) => apifamily.ApiFamilyType == apiFamilyType
        )
      )
    );

    consentLog(
      "Providing a list of banks to the customer for them to choose from the UI"
    );
    res.json(req.session.availableBanks);
  });

  //replace the default certs if the user wants to
  function saveFile(file) {
    const filename = file.name;
    file.mv("./certs/" + filename, function (error) {
      if (error) {
        return false;
      } else {
        return true;
      }
    });
  }

  app.use(uploadFile());
  app.post("/change-config", async (req, res, next) => {

    if (req.files && JSON.parse(req.body.replace_existing_certs)) {
      if (req.files && !Array.isArray(req.files.certificates)) {
        saveFile(req.files.certificates);
      } else {
        req.files.certificates.forEach((cert) => {
          saveFile(cert);
        });
      }
    }

    if(req.body.accept_any_certificates){
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
    }

    req.session.useCustomConfig = true;

    const certsObj = {};

    if (req.files) {
      if (req.files && !Array.isArray(req.files.certificates)) {
        certsObj[req.files.certificates.name] =
          req.files.certificates.data.toString();
      } else {
        req.files.certificates.forEach((cert) => {
          certsObj[cert.name] = cert.data.toString();
        });
      }
    }

    req.session.certificates = certsObj;

    req.session.customConfig = {
      data: {
        client: {
          application_type: req.body.application_type,
          grant_types: [
            "client_credentials",
            "authorization_code",
            "refresh_token",
            "implicit",
          ],
          id_token_signed_response_alg: req.body.id_token_signed_response_alg,
          require_auth_time: JSON.parse(req.body.require_auth_time),
          response_types: ["code id_token", "code"],
          subject_type: req.body.subject_type,
          token_endpoint_auth_method: req.body.token_endpoint_auth_method,
          request_object_signing_alg: req.body.request_object_signing_alg,
          require_signed_request_object: JSON.parse(
            req.body.require_signed_request_object
          ),
          require_pushed_authorization_requests: JSON.parse(
            req.body.require_pushed_authorization_requests
          ),
          tls_client_certificate_bound_access_tokens: JSON.parse(
            req.body.tls_client_certificate_bound_access_tokens
          ),
          client_id: req.body.client_id,
          jwks_uri: req.body.jwks_uri,
          tls_client_auth_subject_dn: req.body.tls_client_auth_subject_dn,
          authorization_signed_response_alg:
            req.body.authorization_signed_response_alg,
        },
        signing_kid: req.body.signing_kid,
        software_statement_id: req.body.software_statement_id,
        organisation_id: req.body.organisation_id,
      },
    };

    req.session.customEnvVars = {
      loop_pause_time: req.body.loop_pause_time,
      number_of_check_loops: req.body.number_of_check_loops,
      preferred_token_auth_mech: req.body.preferred_token_auth_mech,
    };

    await initConfig(req, res, "CUSTOM_CERTS");

    return res.status(201).json({ message: "Form Submitted Successfully" });
  });

  app.post("/payment", async (req, res) => {
    consentLog("Starting a new payment consent");
    let date = new Date();
    const offset = date.getTimezoneOffset();
    date = new Date(date.getTime() - offset * 60 * 1000);

    const data = {
      debtorAccount: {
        number: req.body.debtorAccount_number,
        accountType: req.body.debtorAccount_accountType,
        ispb: req.body.debtorAccount_ispb,
        issuer: req.body.debtorAccount_issuer,
      },
      loggedUser: {
        document: {
          identification: req.body.loggedUser_document_identification,
          rel: req.body.loggedUser_document_rel,
        },
      },
      creditor: {
        name: req.body.creditor_name,
        cpfCnpj: req.body.creditor_cpfCnpj,
        personType: req.body.creditor_personType,
      },
      payment: {
        date: date.toISOString().split("T")[0],
        amount: req.body.payment_amount,
        currency: "BRL",
        details: {
          proxy: "12345678901",
          localInstrument: req.body.payment_details_localInstrument,
          creditorAccount: {
            number: req.body.payment_details_creditAccount_number,
            accountType: req.body.payment_details_creditAccount_accountType,
            ispb: req.body.payment_details_creditAccount_ispb,
            issuer: req.body.payment_details_creditAccount_issuer,
          },
        },
        type: "PIX",
      },
    };

    //if date has been selected
    if (req.body.selected === "Yes") {
      delete data.payment.date;
      req.session.paymentIsScheduled = true;
      data.payment.schedule = {
        single: {
          date: req.body.date,
        },
      };
    } else {
      req.session.paymentIsScheduled = false;
    }

    consentLog(
      "Storing consent payload in a cookie for convenience, server side mechanisms would be more secure and consent payload only just fits in a cookie size"
    );
    res.cookie("consent", JSON.stringify(data), {
      sameSite: "none",
      secure: true,
    });

    //Clear stale cookies on page load
    res.clearCookie("state");
    res.clearCookie("nonce");
    res.clearCookie("code_verifier");

    consentLog(
      "Sending customer to select the bank they want to make the payment from in the next request from the front-end"
    );
    return res.status(200).json({ message: "success" });
  });

  paymentLog(
    "Find payment endpoint with the specified ID for the selected bank from the directory of participants"
  );
  app.get("/payment/:paymentId", async (req, res) => {
    const client = fapiClientSpecificData.find(client => client.sessionId === req.session.id).client;

    const paymentId = req.params.paymentId;

    const paymentEndpoint = `${getEndpoint(
      req.session.selectedAuthServer,
      "payments-pix",
      "open-banking/payments/v1/pix/payments$"
    )}/${paymentId}`;
    paymentLog("Payment endpoint found %O", paymentEndpoint);

    consentLog("Obtaining Payment Access Token");
    const ccToken = await client.grant({
      grant_type: "client_credentials",
      scope: "payments",
    });

    paymentLog("Getting payment response");
    const response = await client.requestResource(paymentEndpoint, ccToken, {
      method: "GET",
      headers: {
        accept: "application/jwt",
        "x-idempotency-key": nanoid(),
      },
    });
    paymentLog("Payment response recieved %O", response);

    consentLog(
      "Retrieve the keyset for the bank sending the payment consent response from the diretory of participants"
    );
    const JWKS = await jose.createRemoteJWKSet(
      new URL(
        `https://keystore.sandbox.directory.openbankingbrasil.org.br/${req.session.selectedOrganisation.OrganisationId}/application.jwks`
      )
    );

    const { payload } = await jose.jwtVerify(response.body.toString(), JWKS, {
      issuer: req.session.selectedOrganisation.OrganisationId,
      audience: req.session.config.data.organisation_id,
      clockTolerance: 2,
    });

    res
      .status(response.statusCode)
      .json({ ...payload, selectedBank: req.session.selectedBank });
  });

  async function getToken(req){
    const client = fapiClientSpecificData.find(client => client.sessionId === req.session.id).client;
    const theTokenSet = req.session.tokenSet;
    const tokenSet = new TokenSet(theTokenSet);
    if(tokenSet.expired()){
      return await client.refresh(theTokenSet.refresh_token);
    }
    return theTokenSet;
  }

  app.use(express.urlencoded());

  //This is used for response mode form_post, query and form_post are the most common
  app.post("/cb", async (req, res) => {

    const fapiClient = fapiClientSpecificData.find(client => client.sessionId === req.session.id);
    const client = fapiClient.client;
    const issuer = fapiClient.issuer;

    consentLog("Received redirect from the bank");
    const callbackParams = client.callbackParams(req);
    consentLog("Trying to obtain an access token using the authorization code");
    const tokenSet = await client.callback(
      "https://tpp.localhost/cb",
      callbackParams,
      {
        code_verifier: req.cookies.code_verifier,
        state: req.cookies.state,
        nonce: req.cookies.nonce,
        response_type: "code",
      },
      {
        clientAssertionPayload: {
          aud: issuer.mtls_endpoint_aliases.token_endpoint,
        },
      }
    );
    consentLog("Access token obtained. %O", tokenSet);

    req.session.refreshToken = tokenSet.refresh_token;
    req.session.accessToken = tokenSet.access_token;
    req.session.tokenSet = tokenSet

    let apiFamilyType;
    let apiEndpointRegex;
    let scope;
    let requestOptions;
    consentLog(
      "Find the consent endpoint to check the status of the consent resource"
    );
    if (req.session.flag === "PAYMENTS") {
      apiFamilyType = "payments-consents";
      apiEndpointRegex = "open-banking/payments/v1/consents$";
      scope = "payments";
      requestOptions = {
        headers: {
          accept: "application/jwt",
          "x-idempotency-key": nanoid(),
        },
      };
    } else {
      apiFamilyType = "consents";
      apiEndpointRegex = "open-banking/consents/v1/consents$";
      scope = "consents";
      requestOptions = {
        headers: {
          method: "GET",
          accept: "application/json",
        },
      };
    }

    //Cut down version of the consent process
    const consentEndpoint = getEndpoint(
      req.session.selectedAuthServer,
      apiFamilyType,
      apiEndpointRegex
    );
    consentLog("Consent endpoint found %O", consentEndpoint);
    consentLog("Obtaining an access token to create the consent record");
    const ccToken = await client.grant({
      grant_type: "client_credentials",
      scope,
    });

    const JWKS = await jose.createRemoteJWKSet(
      new URL(
        `https://keystore.sandbox.directory.openbankingbrasil.org.br/${req.session.selectedOrganisation.OrganisationId}/application.jwks`
      )
    );

    let y = 0;
    while (!["AUTHORISED"].includes(req.session.createdConsent.data.status)) {
      //Create the consent
      consentLog("Get the consent record");
      const consentId = req.session.createdConsent.data.consentId;
      req.session.createdConsent = await client.requestResource(
        `${consentEndpoint}/${consentId}`,
        ccToken,
        requestOptions
      );

      req.session.consentRequestData = {
        endpoint: `${consentEndpoint}/${consentId}`,
        tokenSet: ccToken,
        requestOptions
      };

      let payload;
      if (req.session.flag === "PAYMENTS") {
        //Errors processing a JWT are sent as a
        consentLog(
          "Validate the Consent Response JWT to confirm it was signed correctly by the bank"
        );

        //Validate the jwt
        let result = await jose.jwtVerify(
          req.session.createdConsent.body.toString(),
          JWKS,
          {
            issuer: req.session.selectedOrganisation.OrganisationId,
            audience: req.session.config.data.organisation_id,
            clockTolerance: 2,
          }
        );
        payload = result.payload;
        //Update the consent
        req.session.createdConsent = payload;
        consentLog(
          "Consent response payload validated and extracted successfully"
        );
        consentLog(req.session.createdConsent);
      } else {
        req.session.createdConsent = JSON.parse(
          req.session.createdConsent.body.toString()
        );
      }

      const loopPauseTime = req.session.useCustomConfig
        ? req.session.customEnvVars.loop_pause_time
        : process.env.LOOP_PAUSE_TIME;
      await sleep(loopPauseTime);

      const numberOfCheckLoops = req.session.useCustomConfig
        ? req.session.customEnvVars.number_of_check_loops
        : process.env.NUMBER_OF_CHECK_LOOPS;
      y = y + 1;
      if (y > numberOfCheckLoops) {
        consentLog(
          "Consent has not reached authorised state after 5 iterations, failing"
        );
        payload = {
          msg: "Unable To Complete Authorisation - State Not Authorised",
          payload: payload,
        };
        payload.stringify = JSON.stringify(payload, null, 2);

        req.session.paymentResData = {
          claims: tokenSet.claims(),
          errorPayload,
        };
        return res
          .status(302)
          .redirect("https://tpp.localhost:8080/payment-response");
      }
    }

    consentLog("Consent process finished");
    if (req.session.flag === "PAYMENTS") {
      let consentPayload = req.session.createdConsent;
      consentPayload.stringify = JSON.stringify(
        req.session.createdConsent,
        null,
        2
      );

      paymentLog(
        "Find payment endpoint for the selected bank from the directory of participants"
      );
      const paymentEndpoint = getEndpoint(
        req.session.selectedAuthServer,
        "payments-pix",
        "open-banking/payments/v1/pix/payments$"
      );
      paymentLog("Payment endpoint found %O", paymentEndpoint);
      let date = new Date();
      const offset = date.getTimezoneOffset();
      date = new Date(date.getTime() - offset * 60 * 1000);

      const payment = {
        creditorAccount:
          req.session.createdConsent.data.payment.details.creditorAccount,
        localInstrument:
          req.session.createdConsent.data.payment.details.localInstrument,
        proxy: req.session.createdConsent.data.payment.details.proxy,
        remittanceInformation: "Making a payment",
        cnpjInitiator: "59285411000113",
        payment: {
          amount: req.session.createdConsent.data.payment.amount,
          currency: req.session.createdConsent.data.payment.currency,
        },
      };
      paymentLog("Create payment object %O", payment);
      paymentLog("Signing payment");
      const { signingKey } =  getCerts(req.session.certificates);
      const key = getPrivateKey(signingKey);
      const jwt = await new jose.SignJWT({ data: payment })
        .setProtectedHeader({
          alg: "PS256",
          typ: "JWT",
          kid: req.session.privateJwk.kid,
        })
        .setIssuedAt()
        .setIssuer(req.session.config.data.organisation_id)
        .setJti(nanoid())
        .setAudience(paymentEndpoint)
        .setExpirationTime("5m")
        .sign(key);
      paymentLog("Signed payment JWT %O", jwt);
      paymentLog("Create payment resource using the signed payment JWT ");
      let paymentResponse = await client.requestResource(
        `${paymentEndpoint}`,
        tokenSet,
        {
          body: jwt,
          method: "POST",
          headers: {
            "content-type": "application/jwt",
            "x-idempotency-key": nanoid(),
          },
        }
      );
      paymentLog(
        "Payment resource created successfully %O",
        paymentResponse.body.toString()
      );
      paymentLog("Validate payment response as it is a JWT");
      paymentLog(
        "Retrieve the keyset for the bank (this has already been done and could be cached)"
      );
      //Validate the jwt came from teh correct bank and was meant to be sent to me.
      let { payload } = await jose.jwtVerify(
        paymentResponse.body.toString(),
        JWKS,
        {
          issuer: req.session.selectedOrganisation.OrganisationId,
          audience: req.session.config.data.organisation_id,
          clockTolerance: 2,
        }
      );
      paymentLog("Payment response extracted and validated");

      if (payload.errors) {
        const errorPayload = { msg: "Payment errored", payload: payload };
        errorPayload.stringify = JSON.stringify(errorPayload, null, 2);
        const paymentInfo = payment;
        paymentInfo.stringify = JSON.stringify(paymentInfo, null, 2);

        req.session.paymentResData = {
          claims: tokenSet.claims(),
          errorPayload,
          paymentInfo,
          consentPayload
        };
        return res
          .status(302)
          .redirect("https://tpp.localhost:8080/payment-response");
      }

      let x = 0;
      const loopPauseTime = req.session.useCustomConfig
        ? req.session.customEnvVars.loop_pause_time
        : process.env.LOOP_PAUSE_TIME;
      const numberOfCheckLoops = req.session.useCustomConfig
        ? req.session.customEnvVars.number_of_check_loops
        : process.env.NUMBER_OF_CHECK_LOOPS;
      while (!["ACSP", "ACCC", "RJCT", "SASC"].includes(payload.data.status)) {
        paymentLog(
          "Payment still not in a valid end state. Status: %O. Will check again to see if it has gone through.",
          payload.data.status
        );
        paymentLog(payload);
        paymentLog(
          "Use the self link on the payment to retrieve the latest record status. %O",
          payload.links.self
        );
        paymentResponse = await client.requestResource(
          payload.links.self,
          tokenSet,
          {
            headers: {
              accept: "application/jwt",
              "x-idempotency-key": nanoid(),
            },
          }
        );

        paymentLog("Validate and extract the payment response from the bank");
        ({ payload } = await jose.jwtVerify(
          paymentResponse.body.toString(),
          JWKS,
          {
            issuer: req.session.selectedOrganisation.OrganisationId,
            audience: req.session.config.data.organisation_id,
            clockTolerance: 2,
          }
        ));
        x = x + 1;
        await sleep(loopPauseTime);
        if (x > numberOfCheckLoops) {
          paymentLog(
            "Payment has not reached final state after 5 iterations, failing"
          );
          payload = { msg: "Unable To Complete Payment", payload: payload };
          payload.stringify = JSON.stringify(payload, null, 2);

          consentPayload = {
            msg: "Unable To Complete Payment",
            payload: req.session.createdConsent,
          };
          consentPayload.stringify = JSON.stringify(
            req.session.createdConsent,
            null,
            2
          );

          req.session.paymentResData = {
            claims: tokenSet.claims(),
            payload,
            consentPayload,
          };

          return res
            .status(302)
            .redirect("https://tpp.localhost:8080/payment-response");
        }
      }

      paymentLog("Payment has reached a final state of", payload.data.status);
      paymentLog(payload);
      payload.stringify = JSON.stringify(payload, null, 2);

      consentPayload = req.session.createdConsent;
      consentPayload.stringify = JSON.stringify(
        req.session.createdConsent,
        null,
        2
      );

      req.session.paymentResData = {
        claims: tokenSet.claims(),
        payload,
        consentPayload,
      };

      paymentLog("Payment execution complete");
      return res
        .status(302)
        .redirect("https://tpp.localhost:8080/payment-response");
    }

    paymentLog("Consent execution complete");
    return res
      .status(302)
      .redirect("https://tpp.localhost:8080/consent-response-menu");
  });

  app.get("/consent", (req, res) => {
    return res.json({
      consent: req.session.createdConsent,
      permissionsData: req.session.consentsArr,
      requestData: req.session.consentRequestData
    });
  });

  app.get("/payment-response-data", (req, res) => {
    const paymentResponse = {
      ...req.session.paymentResData,
      clientId: req.session.clientId,
      refreshToken: req.session.refreshToken,
      scheduled: req.session.paymentIsScheduled,
    };

    return res.json(paymentResponse);
  });

  app.get("/clients", async (req, res) => {
    const clients = [];
    await db.collection("clients").find().forEach((client) => {
      clients.push(client);
    });

    res.status(200).json(clients);
  });


  app.post("/dcr", async (req, res) => {
    const selectedBank = req.body.bank;
    req.session.selectedDcrOption = req.body.selectedDcrOption;
    req.session.theClientId = req.body.clientId;
    req.session.registrationAccessToken = req.body.registrationAccessToken;

    if (selectedBank) {
      req.session.selectedBank = selectedBank;
    }
    let client;
    let issuer;
    if (req.session.selectedBank) {
      //Setup the client
      consentLog(
        "Customer has select bank issuer to use %O",
        req.session.selectedBank
      );

      try {
        const { fapiClient, localIssuer } = await setupClient(
          req.session.selectedBank,
          req.session.selectedDcrOption,
          req,
          req.session.theClientId,
          req.session.registrationAccessToken
        );
        consentLog("Client is ready to talk to the chosen bank");
        client = fapiClient;
        issuer = localIssuer;
      } catch (error) {
        res.status(500).json({error: error});
      }

    } else {
      throw Error("No bank was selected");
    }

    //Technically this should be saved into a session but we cannot because an object with methods cannot be stored in session memory
    consentLog('Save fapi client with the session ID into the array');
    fapiClientSpecificData.push({
      sessionId: req.session.id,
      client,
      issuer
    });

    return res.send({
      clientId: client.client_id,
      registrationAccessToken: client.registration_access_token,
      message: "Client is setup",
      scope: client.scope,
    });
  });

  app.options("/makepayment", cors());
  app.post("/makepayment", async (req, res) => {
    const path = "";

    const client = fapiClientSpecificData.find(client => client.sessionId === req.session.id).client;

    let response;
    try {
    //Setup the request
      response =
      await generateRequest(
        client,
        req.session.selectedAuthServer,
        JSON.parse(req.cookies.consent),
        "PAYMENTS",
        req.session.selectedOrganisation,
        req
      );
    } catch(error){
      return res.status(500).json({message: "unable to generate request", error: error});
    }

    const { authUrl, code_verifier, state, nonce, error } = response;

    if (error) {
      const errorPayload = {
        msg: "Unable To Complete Payment",
        payload: error,
      };
      errorPayload.stringify = JSON.stringify(errorPayload, null, 2);
      const paymentInfo = JSON.parse(req.cookies.consent);
      paymentInfo.stringify = JSON.stringify(paymentInfo, null, 2);

      req.session.paymentResData = {
        claims: undefined,
        errorPayload,
        paymentInfo,
      };
      return res
        .status(302)
        .redirect("https://tpp.localhost:8080/payment-response");
    }

    res.cookie("state", state, { path, sameSite: "none", secure: true });
    res.cookie("nonce", nonce, { path, sameSite: "none", secure: true });
    res.cookie("code_verifier", code_verifier, {
      path,
      sameSite: "none",
      secure: true,
    });

    consentLog("Send customer to bank to give consent to the payment");
    return res.json({ authUrl });
  });

  app.get("/payment-consent/:consentId", async (req, res) => {
    const consentId = req.params.consentId;

    const client = fapiClientSpecificData.find(client => client.sessionId === req.session.id).client;

    consentLog(
      "Find the patch consent endpoint for the payments consent from the selected authorisation server from the directory"
    );
    const patchEndpoint = `${getEndpoint(
      req.session.selectedAuthServer,
      "payments-consents",
      "open-banking/payments/v1/consents$"
    )}/${consentId}`;

    consentLog("Obtaining an access token to patch payment");
    const ccToken = await client.grant({
      grant_type: "client_credentials",
      scope: "payments",
    });

    paymentLog("Getting patch payment response ");
    const response = await client.requestResource(patchEndpoint, ccToken, {
      method: "GET",
      headers: {
        accept: "application/jwt",
        "x-idempotency-key": nanoid(),
      },
    });
    paymentLog("Revoked payment response recieved %O", response);

    consentLog(
      "Retrieve the keyset for the bank sending the payment consent response from the diretory of participants"
    );
    const JWKS = await jose.createRemoteJWKSet(
      new URL(
        `https://keystore.sandbox.directory.openbankingbrasil.org.br/${req.session.selectedOrganisation.OrganisationId}/application.jwks`
      )
    );

    const { payload } = await jose.jwtVerify(response.body.toString(), JWKS, {
      issuer: req.session.selectedOrganisation.OrganisationId,
      audience: req.session.config.data.organisation_id,
      clockTolerance: 2,
    });

    res.status(response.statusCode).json(payload);
  });

  app.post("/consent", async (req, res) => {
    const identification = req.body.identification;
    const rel = req.body.rel;
    const grantedPermissions = req.body.permissionsArr.map((permissionData) => {
      return permissionData.permissions.map((data) => {
        return data.permission;
      });
    });

    //granted permissions categories
    req.session.consentsArr = req.body.permissionsArr.map((permissionData) => {
      return {
        category: permissionData.dataCategory,
        id: permissionData.id,
        group: permissionData.group,
        permissions: permissionData.permissions
      };
    });

    let permissions = [];
    for (let permission of grantedPermissions) {
      permissions.push(...permission);
    }

    let date = new Date();
    const offset = date.getTimezoneOffset();
    date = new Date(date.getTime() - offset * 60 * 1000);
    date.setDate(date.getDate() + 30);

    const data = JSON.stringify({
      data: {
        loggedUser: {
          document: {
            identification: identification,
            rel: rel,
          },
        },
        permissions,
        expirationDateTime: date.toISOString(),
      },
    });

    const path = "";

    const client = fapiClientSpecificData.find(client => client.sessionId === req.session.id).client;

    //Setup the request
    const { authUrl, code_verifier, state, nonce, error } =
      await generateRequest(
        client,
        req.session.selectedAuthServer,
        data,
        "CONSENT",
        req.session.selectedOrganisation,
        req
      );

    if (error) {
      const errorPayload = {
        msg: "Unable To Complete Creating Consent",
        payload: error,
      };
      errorPayload.stringify = JSON.stringify(errorPayload, null, 2);
      const consentInfo = JSON.parse(data);
      consentInfo.stringify = JSON.stringify(consentInfo, null, 2);

      req.session.createdConsent = {
        claims: undefined,
        errorPayload,
        consentInfo,
      };
      return res
        .status(302)
        .redirect("https://tpp.localhost:8080/consent-response-menu");
    }

    res.cookie("state", state, { path, sameSite: "none", secure: true });
    res.cookie("nonce", nonce, { path, sameSite: "none", secure: true });
    res.cookie("code_verifier", code_verifier, {
      path,
      sameSite: "none",
      secure: true,
    });

    if (!authUrl) {
      return res.status(400).send({ message: "Bad Request" });
    }

    consentLog("Send customer to bank to give consent to the customer data");
    return res.status(201).send({ authUrl });
  });

  app.patch("/revoke-payment", async (req, res) => {
    const consentId = req.session.createdConsent.data.consentId;

    const client = fapiClientSpecificData.find(client => client.sessionId === req.session.id).client;

    consentLog(
      "Find the patch consent endpoint for the payments consent from the selected authorisation server from the directory"
    );
    const patchEndpoint = `${getEndpoint(
      req.session.selectedAuthServer,
      "payments-consents",
      "open-banking/payments/v1/consents$"
    )}/${consentId}`;

    const payment = {
      status: "REVOKED",
      revocation: {
        loggedUser: {
          document: {
            identification: req.body.document_identification,
            rel: req.body.document_rel,
          },
        },
        revokedBy: req.body.revoked_by,
        reason: {
          code: req.body.code,
          additionalInformation: req.body.additional_info,
        },
      },
    };

    const { signingKey } =  getCerts(req.session.certificates);
    const key = getPrivateKey(signingKey);

    const jwt = await new jose.SignJWT({ data: payment })
      .setProtectedHeader({
        alg: "PS256",
        typ: "JWT",
        kid: req.session.privateJwk.kid,
      })
      .setIssuedAt()
      .setIssuer(req.session.config.data.organisation_id)
      .setJti(nanoid())
      .setAudience(patchEndpoint)
      .setExpirationTime("5m")
      .sign(key);
    consentLog("Log patch signing payment consent JWT");
    consentLog(jwt);

    consentLog("Obtaining an access token to patch payment");
    const ccToken = await client.grant({
      grant_type: "client_credentials",
      scope: "payments",
    });

    paymentLog("Getting patch payment response ");
    const response = await client.requestResource(patchEndpoint, ccToken, {
      method: "PATCH",
      body: jwt,
      headers: {
        "content-type": "application/jwt",
        "x-idempotency-key": nanoid(),
      },
    });
    paymentLog("Revoked payment response recieved %O", response);

    consentLog(
      "Retrieve the keyset for the bank sending the payment consent response from the diretory of participants"
    );
    const JWKS = await jose.createRemoteJWKSet(
      new URL(
        `https://keystore.sandbox.directory.openbankingbrasil.org.br/${req.session.selectedOrganisation.OrganisationId}/application.jwks`
      )
    );

    const { payload } = await jose.jwtVerify(response.body.toString(), JWKS, {
      issuer: req.session.selectedOrganisation.OrganisationId,
      audience: req.session.config.data.organisation_id,
      clockTolerance: 2,
    });

    res.status(response.statusCode).json(payload);
  });

  //Fetch data for the given API
  async function fetchData(req, apiFamilyType, apiType, path = "") {
    const client = fapiClientSpecificData.find(client => client.sessionId === req.session.id).client;

    const tokenSet = await getToken(req);
    req.session.refreshToken = tokenSet.refresh_token;
    req.session.accessToken = tokenSet.access_token;
    req.session.tokenSet = tokenSet;

    let pathRegex;
    if (apiFamilyType === "accounts") {
      pathRegex = "open-banking/accounts/v1/accounts$";
    } else if (apiFamilyType === "credit-cards-accounts") {
      pathRegex = "/open-banking/credit-cards-accounts/v1/accounts$";
    } else if (apiFamilyType === "resources") {
      pathRegex = "open-banking/resources/v1/resources$";
    } else if (apiFamilyType === "customers-business") {
      pathRegex = `open-banking/customers/v1/business/${apiType}$`;
    } else if (apiFamilyType === "customers-personal") {
      pathRegex = `open-banking/customers/v1/personal/${apiType}$`;
    } else if (apiFamilyType === "loans"){
      pathRegex = "open-banking/loans/v1/contracts$"
    } else if (apiFamilyType === "financings"){
      pathRegex = "open-banking/financings/v1/contracts$"
    } else if (apiFamilyType === "invoice-financings"){
      pathRegex = "open-banking/invoice-financings/v1/contracts$"
    } else if (apiFamilyType === "unarranged-accounts-overdraft"){
      pathRegex = "open-banking/unarranged-accounts-overdraft/v1/contracts$"
    }

    paymentLog(
      `Find the ${apiType} endpoint for the selected bank from the directory of participants`
    );
    const endpoint = `${getEndpoint(
      req.session.selectedAuthServer,
      apiFamilyType,
      pathRegex
    )}${path}`;
    consentLog(`The ${apiType} endpoint found %O`, endpoint);

    paymentLog(`Getting ${apiType} response`);
    const response = await client.requestResource(
      endpoint,
      req.session.accessToken
    );

    const requestData = {
      endpoint,
      accessToken: req.session.accessToken
    };

    if (!response.body) {
      return { responseBody: "undefined", statusCode: response.statusCode, requestData };
    }

    return {
      responseBody: JSON.parse(response.body.toString()),
      statusCode: response.statusCode,
      requestData
    };
  }

  function getPathWithParams(queryParams){
    let path = "";
    let isFirstIteration = true;
    for(let queryParam in queryParams){
      if(queryParams[queryParam]){
        if(!isFirstIteration){
          path += `&${queryParam}=${queryParams[queryParam]}`;
        } else {
          isFirstIteration = false;
          path = `?${queryParam}=${queryParams[queryParam]}`;
        }
      }
    }

    return path;
  }

  const accountsApiFamily = "accounts";
  app.get("/accounts", async (req, res) => {

    const path = getPathWithParams(req.query);

    const response = await fetchData(req, accountsApiFamily, accountsApiFamily, path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/accounts/:accountId", async (req, res) => {
    const accountId = req.params.accountId;
    const response = await fetchData(
      req,
      accountsApiFamily,
      "account",
      `/${accountId}`
    );

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/accounts/:accountId/overdraft-limits", async (req, res) => {
    const accountId = req.params.accountId;
    const path = `/${accountId}/overdraft-limits`;

    const response = await fetchData(
      req,
      accountsApiFamily,
      "overdraft limits",
      path
    );

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/accounts/:accountId/balances", async (req, res) => {
    const accountId = req.params.accountId;
    const path = `/${accountId}/balances`;

    const response = await fetchData(req, accountsApiFamily, "balances", path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/accounts/:accountId/transactions", async (req, res) => {
    const accountId = req.params.accountId;
    const queryParams = getPathWithParams(req.query);
    const path = `/${accountId}/transactions${queryParams}`;

    const response = await fetchData(
      req,
      accountsApiFamily,
      "transactions",
      path
    );

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/resources", async (req, res) => {
    const path = getPathWithParams(req.query);

    const response = await fetchData(req, "resources", "resources", path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  const creditCardAccountAPIFamily = "credit-cards-accounts";
  app.get("/credit-cards-accounts", async (req, res) => {
    const path = getPathWithParams(req.query);
    const response = await fetchData(
      req,
      creditCardAccountAPIFamily,
      "credit cards accounts",
      path
    );

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/credit-cards-accounts/:creditCardAccountId", async (req, res) => {
    const creditCardAccountId = req.params.creditCardAccountId;
    const response = await fetchData(
      req,
      creditCardAccountAPIFamily,
      "credit card account",
      `/${creditCardAccountId}`
    );

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get(
    "/credit-cards-accounts/:creditCardAccountId/limits",
    async (req, res) => {
      const creditCardAccountId = req.params.creditCardAccountId;
      const path = `/${creditCardAccountId}/limits`;
      const response = await fetchData(
        req,
        creditCardAccountAPIFamily,
        "credit cards accounts limits",
        path
      );

      return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
    }
  );

  app.get(
    "/credit-cards-accounts/:creditCardAccountId/transactions",
    async (req, res) => {
      const creditCardAccountId = req.params.creditCardAccountId;
      const queryParams = getPathWithParams(req.query);
      const path = `/${creditCardAccountId}/transactions${queryParams}`;
      const response = await fetchData(
        req,
        creditCardAccountAPIFamily,
        "credit cards accounts transactions",
        path
      );

      return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
    }
  );

  app.get(
    "/credit-cards-accounts/:creditCardAccountId/bills",
    async (req, res) => {
      const creditCardAccountId = req.params.creditCardAccountId;
      const queryParams = getPathWithParams(req.query);
      const path = `/${creditCardAccountId}/bills${queryParams}`;
      const response = await fetchData(
        req,
        creditCardAccountAPIFamily,
        "credit cards accounts bills",
        path
      );

      return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
    }
  );

  app.get(
    "/credit-cards-accounts/:creditCardAccountId/bills/:billId/transactions",
    async (req, res) => {
      const creditCardAccountId = req.params.creditCardAccountId;
      const billId = req.params.billId;
      const path = `/${creditCardAccountId}/bills/${billId}/transactions`;
      const response = await fetchData(
        req,
        creditCardAccountAPIFamily,
        "credit cards accounts transactions",
        path
      );

      return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
    }
  );

  app.get("/customers-business/:apiType", async (req, res) => {
    const response = await fetchData(
      req,
      "customers-business",
      req.params.apiType
    );

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/customers-personal/:apiType", async (req, res) => {
    const response = await fetchData(
      req,
      "customers-personal",
      req.params.apiType
    );

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  const loansApiFamily = "loans";
  app.get("/loans", async (req, res) => {

    const path = getPathWithParams(req.query);

    const response = await fetchData(req, loansApiFamily, loansApiFamily, path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/loans/:contractId", async (req, res) => {
    const contractId = req.params.contractId;
    const response = await fetchData(
      req,
      loansApiFamily,
      "loan",
      `/${contractId}`
    );

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/loans/:contractId/warranties", async (req, res) => {
    const contractId = req.params.contractId;
    const queryParams = getPathWithParams(req.query);
    const path = `/${contractId}/warranties${queryParams}`;

    const response = await fetchData(req, loansApiFamily, "warranties", path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/loans/:contractId/scheduled-instalments", async (req, res) => {
    const contractId = req.params.contractId;
    const queryParams = getPathWithParams(req.query);
    const path = `/${contractId}/scheduled-instalments${queryParams}`;

    const response = await fetchData(req, loansApiFamily, "scheduled-instalments", path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/loans/:contractId/payments", async (req, res) => {
    const contractId = req.params.contractId;
    const queryParams = getPathWithParams(req.query);
    const path = `/${contractId}/payments${queryParams}`;

    const response = await fetchData(req, loansApiFamily, "payments", path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  //####################Financings####################################

  const financingsApiFamily = "financings";
  app.get("/financings", async (req, res) => {

    const path = getPathWithParams(req.query);

    const response = await fetchData(req, financingsApiFamily, financingsApiFamily, path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/financings/:contractId", async (req, res) => {
    const contractId = req.params.contractId;
    const response = await fetchData(
      req,
      financingsApiFamily,
      "financing",
      `/${contractId}`
    );

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/financings/:contractId/warranties", async (req, res) => {
    const contractId = req.params.contractId;
    const queryParams = getPathWithParams(req.query);
    const path = `/${contractId}/warranties${queryParams}`;

    const response = await fetchData(req, financingsApiFamily, "warranties", path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/financings/:contractId/scheduled-instalments", async (req, res) => {
    const contractId = req.params.contractId;
    const queryParams = getPathWithParams(req.query);
    const path = `/${contractId}/scheduled-instalments${queryParams}`;

    const response = await fetchData(req, financingsApiFamily, "scheduled-instalments", path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/financings/:contractId/payments", async (req, res) => {
    const contractId = req.params.contractId;
    const queryParams = getPathWithParams(req.query);
    const path = `/${contractId}/payments${queryParams}`;

    const response = await fetchData(req, financingsApiFamily, "payments", path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  //#####################Invoice Financings##############################
  const invoiceFinancingsApiFamily = "invoice-financings";
  app.get("/invoice-financings", async (req, res) => {

    const path = getPathWithParams(req.query);

    const response = await fetchData(req, invoiceFinancingsApiFamily, invoiceFinancingsApiFamily, path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/invoice-financings/:contractId", async (req, res) => {
    const contractId = req.params.contractId;
    const response = await fetchData(
      req,
      invoiceFinancingsApiFamily,
      "invoice-financing",
      `/${contractId}`
    );

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/invoice-financings/:contractId/warranties", async (req, res) => {
    const contractId = req.params.contractId;
    const queryParams = getPathWithParams(req.query);
    const path = `/${contractId}/warranties${queryParams}`;

    const response = await fetchData(req, invoiceFinancingsApiFamily, "warranties", path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/invoice-financings/:contractId/scheduled-instalments", async (req, res) => {
    const contractId = req.params.contractId;
    const queryParams = getPathWithParams(req.query);
    const path = `/${contractId}/scheduled-instalments${queryParams}`;

    const response = await fetchData(req, invoiceFinancingsApiFamily, "scheduled-instalments", path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  app.get("/invoice-financings/:contractId/payments", async (req, res) => {
    const contractId = req.params.contractId;
    const queryParams = getPathWithParams(req.query);
    const path = `/${contractId}/payments${queryParams}`;

    const response = await fetchData(req, invoiceFinancingsApiFamily, "payments", path);

    return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
  });

  //#################### Unarranged Accounts Overdraft #####################
    const UAO_ApiFamily = "unarranged-accounts-overdraft";
    app.get("/unarranged-accounts-overdraft", async (req, res) => {
  
      const path = getPathWithParams(req.query);
  
      const response = await fetchData(req, UAO_ApiFamily, UAO_ApiFamily, path);
  
      return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
    });
  
    app.get("/unarranged-accounts-overdraft/:contractId", async (req, res) => {
      const contractId = req.params.contractId;
      const response = await fetchData(
        req,
        UAO_ApiFamily,
        "unarranged-accounts-overdraft",
        `/${contractId}`
      );
  
      return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
    });
  
    app.get("/unarranged-accounts-overdraft/:contractId/warranties", async (req, res) => {
      const contractId = req.params.contractId;
      const queryParams = getPathWithParams(req.query);
      const path = `/${contractId}/warranties${queryParams}`;
  
      const response = await fetchData(req, UAO_ApiFamily, "warranties", path);
  
      return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
    });
  
    app.get("/unarranged-accounts-overdraft/:contractId/scheduled-instalments", async (req, res) => {
      const contractId = req.params.contractId;
      const queryParams = getPathWithParams(req.query);
      const path = `/${contractId}/scheduled-instalments${queryParams}`;
  
      const response = await fetchData(req, UAO_ApiFamily, "scheduled-instalments", path);
  
      return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
    });
  
    app.get("/unarranged-accounts-overdraft/:contractId/payments", async (req, res) => {
      const contractId = req.params.contractId;
      const queryParams = getPathWithParams(req.query);
      const path = `/${contractId}/payments${queryParams}`;
  
      const response = await fetchData(req, UAO_ApiFamily, "payments", path);
  
      return res.status(response.statusCode).json({responseData: response.responseBody, requestData: response.requestData});
    });

})();
