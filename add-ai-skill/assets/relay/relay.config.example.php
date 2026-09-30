<?php
// ai-agent-drawer relay configuration (for relay.php 1.1+; images need 1.3+). Copy to relay.config.php and edit.
//
// Where the relay looks for it, in order:
//   1. the path in the AIA_RELAY_CONFIG environment/server variable (SetEnv, fastcgi_param, the process environment);
//   2. relay.config.php in AIA_RELAY_DIR (default: a folder named ai-agent-relay next to the web root, i.e. outside
//      it) — recommended in production, where the same folder also holds the rate-limit state;
//   3. relay.config.php next to relay.php — convenient in development; keep it out of version control.
// Keep it a .php file: PHP executes it and never serves its text. Unknown keys are ignored; anything you leave out
// keeps its default. (relay.mjs reads the same keys from relay.config.json / .mjs.)

return [
    // 'local' (default): only requests from the computer the relay runs on; users pick any provider and may type
    // their own keys. 'public': anyone who can load the app, limited to the preset below, with same-origin checks
    // and rate limits.
    'mode' => 'local',

    // The provider, models and address the relay uses. Required in public mode (visitors get exactly this).
    // In local mode it is only a suggestion the drawer picks up with relayProbe.
    'preset' => [
        'provider' => 'openai',                 // lmstudio, ollama, custom, openai, anthropic, google, deepseek, openrouter
        'models'   => ['gpt-5-mini'],           // the first is the default; visitors cannot choose others
        // 'baseUrl' => 'http://10.0.0.5:8000',  // optional: a different address for this provider (e.g. a gateway)
        // 'vision'  => true,                    // optional: whether this model sees images (the drawer's default for
        //                                       // "This model can see images"; false hides screenshots for visitors)
    ],

    // Server-side keys. Environment/server variables win: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY,
    // DEEPSEEK_API_KEY, OPENROUTER_API_KEY (Apache: SetEnv; Nginx + PHP-FPM: fastcgi_param, or env[…] in the pool).
    'keys' => [
        // 'openai' => 'sk-…',
    ],

    // Public mode: pages on other origins that may call the relay (the relay's own host is always allowed).
    'allowedOrigins' => [
        // 'https://www.example.com',
    ],

    // Public mode limits (0 = no limit). Visitors are told when they hit one (HTTP 429 with Retry-After).
    'limits' => [
        'perMinute'       => 6,        // questions per visitor per minute
        'perDay'          => 100,      // questions per visitor per day (UTC)
        'siteDaily'       => 1000,     // questions per day for the whole site
        'maxBodyBytes'    => 524288,   // request size (the page content is part of it)
        'maxMessages'     => 40,       // conversation turns per request
        'maxOutputTokens' => 4096,     // reply tokens (larger requests are lowered to this)
        'maxImages'       => 4,        // screenshots per request (0 = this relay passes no images)
        'maxImageBytes'   => 1572864,  // one screenshot, as base64 text; images come on top of maxBodyBytes
    ],

    // Writable folder, outside the web root, for the rate-limit state (salted daily hashes; no addresses, no text).
    // Default: AIA_RELAY_DIR if it exists, else the system temp folder. It must be inside open_basedir, if set.
    // 'dataDir' => '/var/lib/my-app/ai-agent-relay',

    // Local mode only: also answer other machines. Put a sign-in check in 'authorize' first.
    // 'allowRemote' => false,

    // Your own access check, called before every request (both modes). Return true to allow, or a message to refuse.
    // 'authorize' => static function (): bool|string {
    //     session_start();
    //     if (empty($_SESSION['user_id'])) return 'Sign in to use the assistant.';
    //     return hash_equals($_SESSION['csrf'] ?? '', $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '') ?: 'Reload the page and try again.';
    // },

    // TLS trust for the provider's certificate: '' = php.ini curl.cainfo; a path to a PEM bundle
    // (https://curl.se/ca/cacert.pem); or 'native' = the operating system's store (Windows; also trusts roots added by
    // antivirus HTTPS scanning or a company proxy).
    // 'caBundle' => 'native',

    // 'timeout'   => 300,   // seconds for one reply
    // 'keepalive' => 15,    // seconds between SSE keepalive comments while the model thinks (keep below proxy timeouts)
    // 'allowAnyUpstream' => false,   // local mode: local/custom providers may target hosts outside loopback/LAN
];
