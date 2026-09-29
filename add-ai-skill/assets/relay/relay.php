<?php
declare(strict_types=1);

/**
 * ai-agent-drawer — PHP relay 1.1 (PHP 8.1+ with the curl extension)
 * -------------------------------------------------------------------
 * Copy this file into the application unchanged (e.g. api/relay.php) and point the agent at it:
 *   createAiAgent({ relayProbe: true, defaults: { relayUrl: 'api/relay.php' } })
 * Works with Apache + mod_php (XAMPP), Nginx + PHP-FPM and `php -S`. No rewrites and no .htaccess are needed.
 *
 * The browser sends the conversation here; this file calls the provider with cURL and streams the reply back as
 * Server-Sent Events, in the contract of assets/ai-agent/adapters/relay.js:
 *   POST {action:'chat', provider, baseUrl, model, apiKey, system, messages:[{role,content}], maxTokens, temperature,
 *         reasoning}   -> text/event-stream: delta {text} | reasoning {text} | error {message, code} | done {…}
 *   POST {action:'models', provider, baseUrl, apiKey} -> {ok, models:[{id,label,loaded}]} | {ok:false, error, code}
 *   GET  -> {ok, relay, version, available, mode, providers, serverKeys, preset, reason?}   (always 200)
 *
 * CONFIGURATION lives in a PHP file that returns an array (see relay.config.example.php). It is looked up in:
 *   1. the path in the AIA_RELAY_CONFIG environment/server variable;
 *   2. relay.config.php in the AIA_RELAY_DIR folder (default: a folder named ai-agent-relay next to the web root,
 *      i.e. outside it) — the recommended place in production;
 *   3. relay.config.php next to this file (keep it out of version control).
 * Config files must be .php: inside a web root a .php file is executed, never served; a .json file would be.
 * Environment/server variables can come from the process, Apache SetEnv, or Nginx fastcgi_param: this file reads
 * getenv() and $_SERVER (under PHP-FPM, fastcgi_param values reach both; $_ENV usually does not have them).
 *
 * MODES
 *   local  (default) Only requests from this computer. The user's provider, model and key are used; server keys
 *          from OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY or the config.
 *   public Anyone who can load the app. Only the configured preset (provider, models, server key) is used; visitor
 *          keys are ignored; same-origin is enforced; per-visitor and site-wide rate limits; body/message/token caps.
 * Visitors get generic error messages; configuration details go only to requests from the server itself (and the
 * PHP error log).
 */

const AIA_RELAY_VERSION = '1.1.0';

/** Provider catalog — keep in step with assets/ai-agent/core/providers.js. */
const AIA_PROVIDERS = [
    'lmstudio'   => ['label' => 'LM Studio',   'kind' => 'local',  'protocol' => 'openai',    'base' => 'http://127.0.0.1:9000',  'chat' => '/v1/chat/completions', 'models' => '/api/v1/models', 'alt' => '/v1/models', 'env' => '', 'tokenField' => 'max_tokens', 'temperature' => true, 'reasoningOff' => ['reasoning_effort' => 'none']],
    'ollama'     => ['label' => 'Ollama',      'kind' => 'local',  'protocol' => 'openai',    'base' => 'http://127.0.0.1:11434', 'chat' => '/v1/chat/completions', 'models' => '/v1/models', 'alt' => '', 'env' => '', 'tokenField' => 'max_tokens', 'temperature' => true, 'reasoningOff' => ['reasoning_effort' => 'none']],
    'custom'     => ['label' => 'Custom server', 'kind' => 'custom', 'protocol' => 'openai',  'base' => 'http://127.0.0.1:8080',  'chat' => '/v1/chat/completions', 'models' => '/v1/models', 'alt' => '', 'env' => '', 'tokenField' => 'max_tokens', 'temperature' => true, 'reasoningOff' => null],
    'openai'     => ['label' => 'OpenAI',      'kind' => 'cloud',  'protocol' => 'openai',    'base' => 'https://api.openai.com', 'chat' => '/v1/chat/completions', 'models' => '/v1/models', 'alt' => '', 'env' => 'OPENAI_API_KEY', 'tokenField' => 'max_completion_tokens', 'temperature' => false, 'reasoningOff' => null],
    'anthropic'  => ['label' => 'Anthropic',   'kind' => 'cloud',  'protocol' => 'anthropic', 'base' => 'https://api.anthropic.com', 'chat' => '/v1/messages', 'models' => '/v1/models?limit=1000', 'alt' => '', 'env' => 'ANTHROPIC_API_KEY', 'tokenField' => 'max_tokens', 'temperature' => false, 'reasoningOff' => null],
    'google'     => ['label' => 'Google Gemini', 'kind' => 'cloud', 'protocol' => 'gemini',   'base' => 'https://generativelanguage.googleapis.com', 'chat' => '/v1beta/models/{model}:streamGenerateContent?alt=sse', 'models' => '/v1beta/models?pageSize=1000', 'alt' => '', 'env' => 'GEMINI_API_KEY', 'tokenField' => '', 'temperature' => true, 'reasoningOff' => null],
    'deepseek'   => ['label' => 'DeepSeek',    'kind' => 'cloud',  'protocol' => 'openai',    'base' => 'https://api.deepseek.com', 'chat' => '/chat/completions', 'models' => '/models', 'alt' => '', 'env' => 'DEEPSEEK_API_KEY', 'tokenField' => 'max_tokens', 'temperature' => true, 'reasoningOff' => ['thinking' => ['type' => 'disabled']]],
    'openrouter' => ['label' => 'OpenRouter',  'kind' => 'cloud',  'protocol' => 'openai',    'base' => 'https://openrouter.ai/api', 'chat' => '/v1/chat/completions', 'models' => '/v1/models', 'alt' => '', 'env' => 'OPENROUTER_API_KEY', 'tokenField' => 'max_tokens', 'temperature' => true, 'reasoningOff' => null],
];

/**
 * A refusal with its HTTP status and the drawer's error code. The message is safe for visitors; `detail` (what is
 * misconfigured, what the provider said) goes only to requests from this computer and to the error log.
 */
final class AiaRelayError extends RuntimeException
{
    /** @param array<string, string> $headers */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly string $detail = '',
        public readonly array $headers = [],
    ) {
        parent::__construct($message);
    }

    public static function misconfigured(string $detail): self
    {
        return new self(503, 'refused', 'The assistant is not available right now.', $detail);
    }
}

/* ------------------------------------------------------------------------------------------------ config */

/** An environment/server variable: process environment, Apache SetEnv, or Nginx fastcgi_param. */
function aia_env(string $name): string
{
    $v = getenv($name);
    if (is_string($v) && $v !== '') {
        return $v;
    }
    foreach ([$name, 'REDIRECT_' . $name] as $k) {
        $v = $_SERVER[$k] ?? null;
        if (is_string($v) && $v !== '') {
            return $v;
        }
    }
    return '';
}

/** The runtime/data folder outside the web root: AIA_RELAY_DIR, or "ai-agent-relay" next to the document root. */
function aia_relay_dir(): string
{
    $dir = aia_env('AIA_RELAY_DIR');
    if ($dir !== '') {
        return rtrim($dir, '/\\');
    }
    $root = (string) ($_SERVER['DOCUMENT_ROOT'] ?? '');
    return $root !== '' ? dirname(rtrim($root, '/\\')) . DIRECTORY_SEPARATOR . 'ai-agent-relay' : '';
}

/** @return array<string, mixed> */
function aia_config_defaults(string $mode): array
{
    $public = $mode === 'public';
    return [
        'mode'             => $mode,
        'allowRemote'      => false,      // local mode: also answer other machines (put 'authorize' in front of it)
        'authorize'        => null,       // callable(): bool|string — your sign-in/CSRF check; a string refuses with that message
        'preset'           => null,       // ['provider' => …, 'models' => [...], 'model' => default, 'baseUrl' => optional]
        'keys'             => [],         // provider id => key; environment/server variables win
        'allowedOrigins'   => [],         // public mode: other origins whose pages may call this relay
        'dataDir'          => '',         // writable folder outside the web root for rate-limit state
        'timeout'          => 300,        // seconds for one reply
        'keepalive'        => 15,         // seconds between SSE keepalive comments while the model is silent
        'allowAnyUpstream' => false,      // local/custom providers may target any host (not only loopback/LAN)
        'caBundle'         => '',         // '' = php.ini curl.cainfo · a PEM file path · 'native' = the OS store (Windows)
        'limits'           => [
            'perMinute'       => $public ? 6 : 0,        // questions per visitor per minute (0 = no limit)
            'perDay'          => $public ? 100 : 0,      // questions per visitor per day
            'siteDaily'       => $public ? 1000 : 0,     // questions per day for the whole site
            'maxBodyBytes'    => $public ? 512 * 1024 : 4 * 1024 * 1024,
            'maxMessages'     => $public ? 40 : 400,
            'maxOutputTokens' => $public ? 4096 : 64000,
        ],
    ];
}

/**
 * The configuration, loaded once.
 * @return array<string, mixed>
 */
function aia_config(): array
{
    static $cfg = null;
    if ($cfg !== null) {
        return $cfg;
    }
    $candidates = [];
    $explicit = aia_env('AIA_RELAY_CONFIG');
    if ($explicit !== '') {
        $candidates[] = [$explicit, true];
    }
    $dir = aia_relay_dir();
    if ($dir !== '') {
        $candidates[] = [$dir . DIRECTORY_SEPARATOR . 'relay.config.php', false];
    }
    $candidates[] = [__DIR__ . DIRECTORY_SEPARATOR . 'relay.config.php', false];

    $raw = [];
    $source = '';
    foreach ($candidates as [$file, $required]) {
        if (strtolower(substr($file, -4)) !== '.php') {
            throw AiaRelayError::misconfigured('The relay config must be a .php file that returns an array (a .json file inside a web root would be served to anyone): ' . $file);
        }
        if (!@is_file($file)) {                     // @: open_basedir may not include the folder
            if ($required) {
                throw AiaRelayError::misconfigured('AIA_RELAY_CONFIG points to ' . $file . ', which does not exist or is outside open_basedir.');
            }
            continue;
        }
        $loaded = (static function (string $f): mixed {
            return require $f;
        })($file);
        if (!is_array($loaded)) {
            throw AiaRelayError::misconfigured($file . ' must return an array (return [ … ];).');
        }
        $raw = $loaded;
        $source = $file;
        break;
    }

    $mode = ($raw['mode'] ?? 'local') === 'public' ? 'public' : 'local';
    $d = aia_config_defaults($mode);
    $cfg = array_replace($d, array_intersect_key($raw, $d));
    $cfg['limits'] = array_replace($d['limits'], is_array($raw['limits'] ?? null) ? array_intersect_key($raw['limits'], $d['limits']) : []);
    foreach ($cfg['limits'] as $k => $v) {
        $cfg['limits'][$k] = max(0, (int) $v);
    }
    $cfg['keys'] = is_array($cfg['keys']) ? $cfg['keys'] : [];
    $cfg['allowedOrigins'] = array_values(array_filter(array_map('strval', is_array($cfg['allowedOrigins']) ? $cfg['allowedOrigins'] : [])));
    $cfg['timeout'] = max(10, (int) $cfg['timeout']);
    $cfg['keepalive'] = max(1, (int) $cfg['keepalive']);
    $cfg['source'] = $source;
    $cfg['preset'] = aia_normalize_preset($cfg['preset']);
    if ($cfg['authorize'] !== null && !is_callable($cfg['authorize'])) {
        throw AiaRelayError::misconfigured('"authorize" in ' . $source . ' must be a function.');
    }
    return $cfg;
}

/** @return array{provider: string, models: list<string>, model: string, baseUrl: string}|null */
function aia_normalize_preset(mixed $p): ?array
{
    if (!is_array($p) || !isset(AIA_PROVIDERS[(string) ($p['provider'] ?? '')])) {
        return null;
    }
    $models = array_values(array_filter(array_map('strval', is_array($p['models'] ?? null) ? $p['models'] : [])));
    $model = (string) ($p['model'] ?? ($models[0] ?? ''));
    if ($model !== '' && !in_array($model, $models, true)) {
        array_unshift($models, $model);
    }
    return ['provider' => (string) $p['provider'], 'models' => $models, 'model' => $model, 'baseUrl' => trim((string) ($p['baseUrl'] ?? ''))];
}

/** Public mode cannot run without a preset and its key: say exactly what is missing (to local requests). */
function aia_public_problem(array $cfg): string
{
    $p = $cfg['preset'];
    if ($p === null) {
        return 'Public mode needs a "preset" with a known provider in ' . ($cfg['source'] ?: 'the relay config') . '.';
    }
    if (AIA_PROVIDERS[$p['provider']]['kind'] === 'cloud' && aia_server_key($p['provider'], $cfg) === '') {
        return 'Public mode: no key for ' . $p['provider'] . '. Set ' . AIA_PROVIDERS[$p['provider']]['env'] . ' (environment, SetEnv or fastcgi_param) or "keys" in the config.';
    }
    if ($p['model'] === '' && $p['provider'] !== 'lmstudio' && $p['provider'] !== 'custom') {
        return 'Public mode: the preset needs "models" (the first is the default).';
    }
    return '';
}

function aia_server_key(string $id, array $cfg): string
{
    $env = AIA_PROVIDERS[$id]['env'] ?? '';
    $key = $env !== '' ? aia_env($env) : '';
    if ($key === '' && isset($cfg['keys'][$id]) && is_string($cfg['keys'][$id])) {
        $key = trim($cfg['keys'][$id]);
    }
    return $key;
}

/* ------------------------------------------------------------------------------------------------ output */

/** @param array<string, string> $headers */
function aia_json(int $status, array $body, array $headers = []): never
{
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
        foreach ($headers as $k => $v) {
            header($k . ': ' . $v);
        }
    }
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function aia_flush(): void
{
    if (ob_get_level() > 0) {
        @ob_flush();
    }
    @flush();
}

function aia_sse(string $event, array $data): void
{
    echo 'event: ' . $event . "\n";
    echo 'data: ' . json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) . "\n\n";
    aia_flush();
}

/** An SSE comment: ignored by the client, but it keeps proxies (fastcgi_read_timeout) from timing out. */
function aia_sse_comment(string $text): void
{
    echo ': ' . $text . "\n\n";
    aia_flush();
}

/** Headers for a stream, compression and buffering off, and a first byte so every layer sends the headers now. */
function aia_begin_stream(int $timeout): void
{
    while (ob_get_level() > 0) {
        @ob_end_clean();
    }
    @ini_set('zlib.output_compression', '0');
    @ini_set('implicit_flush', '1');
    if (function_exists('apache_setenv')) {
        @apache_setenv('no-gzip', '1');          // Apache mod_deflate: do not buffer this response to compress it
    }
    ignore_user_abort(true);                      // we notice the visitor leaving (Stop) and abort the upstream call
    set_time_limit($timeout + 30);
    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Accel-Buffering: no');              // Nginx: do not buffer this response
    header('X-Content-Type-Options: nosniff');
    aia_sse_comment('open');
}

/* --------------------------------------------------------------------------------------- request checks */

function aia_is_local_request(): bool
{
    // A request that came through a proxy is not "from this computer", even if the proxy is.
    foreach (['HTTP_X_FORWARDED_FOR', 'HTTP_FORWARDED', 'HTTP_X_REAL_IP', 'HTTP_CF_CONNECTING_IP', 'HTTP_TRUE_CLIENT_IP'] as $h) {
        if (!empty($_SERVER[$h])) {
            return false;
        }
    }
    $addr = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    return $addr === '::1' || str_starts_with($addr, '127.') || str_starts_with($addr, '::ffff:127.');
}

function aia_is_local_url(string $url): bool
{
    $host = strtolower(trim((string) parse_url($url, PHP_URL_HOST), '[]'));
    if ($host === '') {
        return false;
    }
    if (in_array($host, ['localhost', '::1', '0.0.0.0'], true) || str_ends_with($host, '.localhost') || str_ends_with($host, '.local')) {
        return true;
    }
    if (!preg_match('/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/', $host, $m)) {
        return false;
    }
    $a = (int) $m[1];
    $b = (int) $m[2];
    return $a === 127 || $a === 10 || ($a === 192 && $b === 168) || ($a === 172 && $b >= 16 && $b <= 31);
}

/** host[:port] without the scheme's default port, lower-case. */
function aia_authority(string $host, string $scheme): string
{
    $host = strtolower(trim($host));
    $default = $scheme === 'https' ? ':443' : ':80';
    return str_ends_with($host, $default) ? substr($host, 0, -strlen($default)) : $host;
}

/** Public mode: only the application's own pages (or the listed origins) may call the relay. No CORS headers. */
function aia_check_same_origin(array $cfg): void
{
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'ai-agent-drawer') {
        throw new AiaRelayError(403, 'refused', 'Requests must come from the application\'s own pages.', 'Missing the X-Requested-With: ai-agent-drawer header.');
    }
    $origin = rtrim((string) ($_SERVER['HTTP_ORIGIN'] ?? ''), '/');
    $parts = $origin !== '' ? parse_url($origin) : false;
    if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])) {
        throw new AiaRelayError(403, 'refused', 'Requests must come from the application\'s own pages.', 'Missing or malformed Origin header.');
    }
    $scheme = strtolower($parts['scheme']);
    $theirs = aia_authority($parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : ''), $scheme);
    $ours = aia_authority((string) ($_SERVER['HTTP_HOST'] ?? ''), $scheme);
    $listed = in_array(strtolower($origin), array_map(static fn (string $o): string => strtolower(rtrim($o, '/')), $cfg['allowedOrigins']), true);
    if ($theirs !== $ours && !$listed) {
        throw new AiaRelayError(403, 'refused', 'This assistant only answers pages of the site it runs on.', 'Origin ' . $origin . ' is not this host (' . $ours . ') and not in allowedOrigins.');
    }
    $site = strtolower((string) ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? ''));
    if ($site !== '' && $site !== 'same-origin' && !$listed) {
        throw new AiaRelayError(403, 'refused', 'This assistant only answers pages of the site it runs on.', 'Sec-Fetch-Site: ' . $site);
    }
}

function aia_authorize(array $cfg): void
{
    if ($cfg['authorize'] === null) {
        return;
    }
    $r = ($cfg['authorize'])();
    if ($r === true) {
        return;
    }
    throw new AiaRelayError(403, 'refused', is_string($r) && $r !== '' ? $r : 'Sign in to use the assistant.');
}

/** The part of an address that identifies a visitor: IPv4 as is, IPv6 by its /64 network. */
function aia_address_key(string $addr): string
{
    $bin = @inet_pton($addr);
    if ($bin === false) {
        return $addr;
    }
    if (strlen($bin) === 16 && str_starts_with($bin, str_repeat("\0", 10) . "\xff\xff")) {
        return inet_ntop(substr($bin, 12)) ?: $addr;             // IPv4-mapped IPv6
    }
    return strlen($bin) === 16 ? bin2hex(substr($bin, 0, 8)) . '/64' : $addr;
}

function aia_data_dir(array $cfg): string
{
    $dir = trim((string) $cfg['dataDir']);
    if ($dir === '') {
        $relayDir = aia_relay_dir();
        $dir = $relayDir !== '' && @is_dir($relayDir) ? $relayDir : sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'ai-agent-relay-' . substr(md5(__FILE__), 0, 8);
    }
    if (!@is_dir($dir) && !@mkdir($dir, 0700, true) && !@is_dir($dir)) {
        throw AiaRelayError::misconfigured('Cannot create the relay data folder ' . $dir . ' (check permissions and open_basedir).');
    }
    if (!@is_writable($dir)) {
        throw AiaRelayError::misconfigured('The relay data folder ' . $dir . ' is not writable by PHP.');
    }
    return $dir;
}

/**
 * Count one question against the per-visitor (minute, day) and site-wide (day) limits. State lives in a locked JSON
 * file: no addresses and no conversation text, only salted hashes that change every day (UTC).
 */
function aia_rate_limit(array $cfg): void
{
    $l = $cfg['limits'];
    if ($l['perMinute'] <= 0 && $l['perDay'] <= 0 && $l['siteDaily'] <= 0) {
        return;
    }
    $file = aia_data_dir($cfg) . DIRECTORY_SEPARATOR . 'relay-limits.json';
    $fh = @fopen($file, 'c+');
    if ($fh === false) {
        throw AiaRelayError::misconfigured('Cannot open ' . $file . ' for the rate limits.');
    }
    try {
        if (!flock($fh, LOCK_EX)) {
            throw AiaRelayError::misconfigured('Cannot lock ' . $file . '.');
        }
        $state = json_decode((string) stream_get_contents($fh), true);
        $now = time();
        $day = gmdate('Y-m-d', $now);
        if (!is_array($state) || ($state['day'] ?? '') !== $day || !is_string($state['salt'] ?? null)) {
            $state = ['day' => $day, 'salt' => bin2hex(random_bytes(16)), 'site' => 0, 'visitors' => []];
        }
        $id = substr(hash_hmac('sha256', aia_address_key((string) ($_SERVER['REMOTE_ADDR'] ?? '')), $state['salt']), 0, 20);
        [$windowStart, $inWindow, $today] = $state['visitors'][$id] ?? [0, 0, 0];
        if ($now - (int) $windowStart >= 60) {
            $windowStart = $now;
            $inWindow = 0;
        }
        $tomorrow = (int) gmmktime(0, 0, 0, (int) gmdate('n', $now), (int) gmdate('j', $now) + 1, (int) gmdate('Y', $now)) - $now;
        if ($l['siteDaily'] > 0 && (int) $state['site'] >= $l['siteDaily']) {
            throw new AiaRelayError(429, 'rate-limit', 'The assistant has reached its limit for today. Please try again tomorrow.', 'siteDaily reached', ['Retry-After' => (string) $tomorrow]);
        }
        if ($l['perDay'] > 0 && (int) $today >= $l['perDay']) {
            throw new AiaRelayError(429, 'rate-limit', 'You have reached today\'s limit of ' . $l['perDay'] . ' questions. Please try again tomorrow.', '', ['Retry-After' => (string) $tomorrow]);
        }
        if ($l['perMinute'] > 0 && (int) $inWindow >= $l['perMinute']) {
            $wait = max(1, 60 - ($now - (int) $windowStart));
            throw new AiaRelayError(429, 'rate-limit', 'Too many questions in a row (limit ' . $l['perMinute'] . ' per minute). Try again in ' . $wait . ' s.', '', ['Retry-After' => (string) $wait]);
        }
        $state['visitors'][$id] = [$windowStart, (int) $inWindow + 1, (int) $today + 1];
        $state['site'] = (int) $state['site'] + 1;
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, (string) json_encode($state));
        fflush($fh);
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}

/* ------------------------------------------------------------------------------------ provider plumbing */

function aia_redact(string $text, string $key): string
{
    if (strlen($key) >= 4) {
        $text = str_replace($key, '[redacted]', $text);
    }
    return (string) preg_replace('/(bearer\s+|x-api-key:\s*|x-goog-api-key:\s*|key=)[^\s"&]+/i', '$1[redacted]', $text);
}

function aia_join(string $base, string $path): string
{
    $base = rtrim($base, '/');
    if (preg_match('#^/v1(beta)?/#', $path, $m) && str_ends_with($base, rtrim($m[0], '/'))) {
        $base = substr($base, 0, -strlen(rtrim($m[0], '/')));
    }
    return $base . $path;
}

/**
 * Which provider, address, model and key a request may use.
 * @return array<string, mixed>
 */
function aia_target(array $req, array $cfg, bool $forListing = false): array
{
    $id = (string) ($req['provider'] ?? '');
    if (!isset(AIA_PROVIDERS[$id])) {
        throw new AiaRelayError(400, 'refused', 'Unknown provider "' . substr($id, 0, 40) . '".');
    }
    $p = AIA_PROVIDERS[$id];
    $wantedModel = trim((string) ($req['model'] ?? ''));

    if ($cfg['mode'] === 'public') {
        $problem = aia_public_problem($cfg);
        if ($problem !== '') {
            throw AiaRelayError::misconfigured($problem);
        }
        $preset = $cfg['preset'];
        if ($id !== $preset['provider']) {
            throw new AiaRelayError(400, 'refused', 'This assistant only offers ' . AIA_PROVIDERS[$preset['provider']]['label'] . '. Choose it in Settings > Model.');
        }
        $model = $wantedModel === '' ? $preset['model'] : $wantedModel;
        if (!$forListing && $preset['models'] !== [] && !in_array($model, $preset['models'], true)) {
            throw new AiaRelayError(400, 'missing-model', 'This assistant only offers ' . (count($preset['models']) === 1 ? 'the model ' : 'these models: ') . implode(', ', $preset['models']) . '. Choose it in Settings > Model.');
        }
        $base = $preset['baseUrl'] !== '' ? $preset['baseUrl'] : $p['base'];
        $key = aia_server_key($id, $cfg);                     // visitor keys are never forwarded
        return $p + ['id' => $id, 'baseUrl' => rtrim($base, '/'), 'key' => $key, 'model' => $model];
    }

    $base = $p['base'];
    if ($cfg['preset'] !== null && $cfg['preset']['provider'] === $id && $cfg['preset']['baseUrl'] !== '') {
        $base = $cfg['preset']['baseUrl'];
    }
    $wanted = trim((string) ($req['baseUrl'] ?? ''));
    if ($wanted !== '' && $p['kind'] !== 'cloud') {
        if (!preg_match('#^https?://#i', $wanted)) {
            throw new AiaRelayError(400, 'bad-endpoint', 'The server address must start with http:// or https://.');
        }
        if (!$cfg['allowAnyUpstream'] && !aia_is_local_url($wanted)) {
            throw new AiaRelayError(400, 'refused', 'This relay only forwards ' . $p['label'] . ' requests to local/private addresses (allowAnyUpstream in the relay config).');
        }
        $base = $wanted;
    }
    $key = trim((string) ($req['apiKey'] ?? ''));
    if ($key === '') {
        $key = aia_server_key($id, $cfg);
    }
    if ($p['kind'] === 'cloud' && $key === '') {
        throw new AiaRelayError(400, 'auth', $p['label'] . ' needs an API key: type one in Settings, or set ' . $p['env'] . ' on the server.');
    }
    return $p + ['id' => $id, 'baseUrl' => rtrim($base, '/'), 'key' => $key, 'model' => $wantedModel];
}

/** @return list<string> */
function aia_headers(array $t): array
{
    $h = ['Content-Type: application/json'];
    if ($t['protocol'] === 'anthropic') {
        $h[] = 'x-api-key: ' . $t['key'];
        $h[] = 'anthropic-version: 2023-06-01';
    } elseif ($t['protocol'] === 'gemini') {
        $h[] = 'x-goog-api-key: ' . $t['key'];
    } elseif ($t['key'] !== '') {
        $h[] = 'Authorization: Bearer ' . $t['key'];
    }
    return $h;
}

/** @param \CurlHandle $ch */
function aia_curl_tls($ch, array $cfg): void
{
    $ca = (string) $cfg['caBundle'];
    if ($ca === 'native') {
        // The operating system's certificate store (libcurl 7.71+ with OpenSSL on Windows). Also trusts roots that
        // antivirus HTTPS scanning or a company proxy adds, which PEM bundles do not contain.
        curl_setopt($ch, CURLOPT_SSL_OPTIONS, defined('CURLSSLOPT_NATIVE_CA') ? CURLSSLOPT_NATIVE_CA : 16);
    } elseif ($ca !== '') {
        curl_setopt($ch, CURLOPT_CAINFO, $ca);
    }
}

/** Keep only user/assistant turns, merge repeats, start with the user. */
function aia_messages(array $raw): array
{
    $out = [];
    foreach ($raw as $m) {
        $role = is_array($m) ? (string) ($m['role'] ?? '') : '';
        $content = is_array($m) ? trim((string) ($m['content'] ?? '')) : '';
        if (!in_array($role, ['user', 'assistant'], true) || $content === '') {
            continue;
        }
        $last = count($out) - 1;
        if ($last >= 0 && $out[$last]['role'] === $role) {
            $out[$last]['content'] .= "\n\n" . $content;
        } else {
            $out[] = ['role' => $role, 'content' => $content];
        }
    }
    if ($out !== [] && $out[0]['role'] === 'assistant') {
        array_unshift($out, ['role' => 'user', 'content' => '(The conversation continues.)']);
    }
    return $out;
}

function aia_check_messages(array $raw, array $cfg): void
{
    if ($cfg['limits']['maxMessages'] > 0 && count($raw) > $cfg['limits']['maxMessages']) {
        throw new AiaRelayError(413, 'budget', 'This conversation is too long for the assistant (' . count($raw) . ' messages, limit ' . $cfg['limits']['maxMessages'] . '). Start a new chat, or lower "Conversation memory" in Settings > Agent.');
    }
}

/** @return array{0: string, 1: array<string, mixed>} url and body */
function aia_chat_request(array $t, array $req, array $cfg): array
{
    $system = (string) ($req['system'] ?? '');
    $raw = is_array($req['messages'] ?? null) ? $req['messages'] : [];
    aia_check_messages($raw, $cfg);
    $messages = aia_messages($raw);
    $cap = $cfg['limits']['maxOutputTokens'] > 0 ? $cfg['limits']['maxOutputTokens'] : 64000;
    $maxTokens = max(64, min($cap, (int) ($req['maxTokens'] ?? 2048)));
    $temperature = is_numeric($req['temperature'] ?? null) ? max(0.0, min(2.0, (float) $req['temperature'])) : 0.4;
    $reasoningOff = ($req['reasoning'] ?? '') === 'off';

    if ($t['protocol'] === 'anthropic') {
        if ($t['model'] === '') {
            throw new AiaRelayError(400, 'missing-model', 'Choose an Anthropic model in Settings.');
        }
        $body = ['model' => $t['model'], 'max_tokens' => $maxTokens, 'messages' => $messages, 'stream' => true];
        if ($system !== '') {
            $body['system'] = $system;
        }
        if ($reasoningOff) {
            $body['thinking'] = ['type' => 'disabled'];
        }
        return [aia_join($t['baseUrl'], $t['chat']), $body];
    }

    if ($t['protocol'] === 'gemini') {
        if ($t['model'] === '') {
            throw new AiaRelayError(400, 'missing-model', 'Choose a Gemini model in Settings.');
        }
        $body = [
            'contents' => array_map(static fn (array $m): array => ['role' => $m['role'] === 'assistant' ? 'model' : 'user', 'parts' => [['text' => $m['content']]]], $messages),
            'generationConfig' => ['maxOutputTokens' => $maxTokens, 'temperature' => $temperature],
        ];
        if ($system !== '') {
            $body['systemInstruction'] = ['parts' => [['text' => $system]]];
        }
        $path = str_replace('{model}', rawurlencode((string) preg_replace('#^models/#', '', $t['model'])), $t['chat']);
        return [aia_join($t['baseUrl'], $path), $body];
    }

    $body = ['messages' => array_merge($system !== '' ? [['role' => 'system', 'content' => $system]] : [], $messages), 'stream' => true];
    if ($t['model'] !== '') {
        $body['model'] = $t['model'];
    }
    $body[$t['tokenField'] ?: 'max_tokens'] = $maxTokens;
    if ($t['temperature']) {
        $body['temperature'] = $temperature;
    }
    if ($reasoningOff && is_array($t['reasoningOff'])) {
        $body += $t['reasoningOff'];
    }
    return [aia_join($t['baseUrl'], $t['chat']), $body];
}

/** One SSE `data:` payload -> [['reasoning'|'text', string], …]. Throws on an error payload. */
function aia_fragments(string $protocol, array $e): array
{
    if (isset($e['error'])) {
        $msg = is_array($e['error']) ? (string) ($e['error']['message'] ?? 'The model returned an error.') : (string) $e['error'];
        throw new RuntimeException($msg);
    }
    $out = [];
    if ($protocol === 'anthropic') {
        $d = $e['delta'] ?? null;
        if (($e['type'] ?? '') === 'content_block_delta' && is_array($d)) {
            if (($d['type'] ?? '') === 'text_delta' && isset($d['text'])) {
                $out[] = ['text', (string) $d['text']];
            } elseif (($d['type'] ?? '') === 'thinking_delta' && isset($d['thinking'])) {
                $out[] = ['reasoning', (string) $d['thinking']];
            }
        }
        return $out;
    }
    if ($protocol === 'gemini') {
        foreach (($e['candidates'][0]['content']['parts'] ?? []) as $part) {
            if (is_array($part) && isset($part['text']) && $part['text'] !== '') {
                $out[] = [!empty($part['thought']) ? 'reasoning' : 'text', (string) $part['text']];
            }
        }
        return $out;
    }
    $d = $e['choices'][0]['delta'] ?? $e['choices'][0]['message'] ?? null;
    if (is_array($d)) {
        $r = $d['reasoning_content'] ?? $d['reasoning'] ?? null;
        if (is_string($r) && $r !== '') {
            $out[] = ['reasoning', $r];
        }
        if (is_string($d['content'] ?? null) && $d['content'] !== '') {
            $out[] = ['text', $d['content']];
        }
    }
    return $out;
}

function aia_error_detail(string $body): string
{
    $j = json_decode(trim($body), true);
    if (!is_array($j)) {
        return trim(substr($body, 0, 400));
    }
    foreach ([$j['error']['message'] ?? null, $j['error'] ?? null, $j['message'] ?? null] as $c) {
        if (is_string($c) && trim($c) !== '') {
            return trim($c);
        }
    }
    return '';
}

function aia_code_for(int $status, string $detail): string
{
    if ($status === 401 || $status === 403) {
        return 'auth';
    }
    if ($status === 429) {
        return 'rate-limit';
    }
    if (preg_match('/model/i', $detail) && in_array($status, [400, 404, 422, 500], true)) {
        return 'missing-model';
    }
    if ($status === 404 || $status === 405) {
        return 'bad-endpoint';
    }
    return $status >= 500 ? 'network' : 'refused';
}

/* ---------------------------------------------------------------------------------------------- endpoints */

/** GET reply for a client this relay will not serve: still 200, so a probe never puts an error in the console. */
function aia_unavailable(string $mode, string $reason, string $detail = ''): never
{
    $body = ['ok' => true, 'relay' => 'ai-agent-drawer', 'version' => AIA_RELAY_VERSION, 'mode' => $mode, 'available' => false,
        'providers' => [], 'serverKeys' => [], 'preset' => null, 'reason' => $reason];
    if ($detail !== '' && aia_is_local_request()) {
        $body['detail'] = $detail;
    }
    aia_json(200, $body);
}

/** GET: what this relay offers this client. */
function aia_info(array $cfg): never
{
    $base = ['ok' => true, 'relay' => 'ai-agent-drawer', 'version' => AIA_RELAY_VERSION, 'mode' => $cfg['mode']];
    if ($cfg['mode'] === 'local' && !$cfg['allowRemote'] && !aia_is_local_request()) {
        aia_unavailable('local', 'This relay only answers requests from the computer it runs on.');
    }
    if ($cfg['authorize'] !== null) {
        try {
            aia_authorize($cfg);
        } catch (AiaRelayError $e) {
            aia_unavailable($cfg['mode'], $e->getMessage());
        }
    }
    if ($cfg['mode'] === 'public') {
        $problem = aia_public_problem($cfg);
        if ($problem !== '') {
            error_log('[ai-agent relay] ' . $problem);
            aia_unavailable('public', 'The assistant is not available right now.', $problem);
        }
        $p = $cfg['preset'];
        aia_json(200, $base + [
            'available' => true,
            'providers' => [$p['provider']],
            'serverKeys' => [$p['provider'] => true],
            'preset' => ['provider' => $p['provider'], 'model' => $p['model'], 'models' => $p['models']],
            'limits' => ['perMinute' => $cfg['limits']['perMinute'], 'perDay' => $cfg['limits']['perDay']],
        ]);
    }
    $keys = [];
    foreach (AIA_PROVIDERS as $id => $p) {
        if ($p['env'] !== '') {
            $keys[$id] = aia_server_key($id, $cfg) !== '';
        }
    }
    $preset = $cfg['preset'] !== null ? ['provider' => $cfg['preset']['provider'], 'model' => $cfg['preset']['model'], 'models' => $cfg['preset']['models']] : null;
    aia_json(200, $base + ['available' => true, 'providers' => array_keys(AIA_PROVIDERS), 'serverKeys' => $keys, 'preset' => $preset]);
}

function aia_models(array $t, array $cfg): never
{
    if ($cfg['mode'] === 'public') {
        $list = array_map(static fn (string $m): array => ['id' => $m, 'label' => $m, 'loaded' => false], $cfg['preset']['models']);
        aia_json(200, ['ok' => true, 'models' => $list]);
    }
    $paths = array_values(array_filter([$t['models'], $t['alt']]));
    $lastError = 'No models path.';
    foreach ($paths as $path) {
        $ch = curl_init(aia_join($t['baseUrl'], $path));
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT        => 20,
            CURLOPT_HTTPHEADER     => array_merge(['Accept: application/json'], array_slice(aia_headers($t), 1)),
        ]);
        aia_curl_tls($ch, $cfg);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if (!is_string($body) || $status !== 200) {
            $lastError = !is_string($body) ? ($err ?: 'Could not connect.') : ('HTTP ' . $status . ' ' . aia_error_detail($body));
            continue;
        }
        $j = json_decode($body, true);
        $models = [];
        foreach ((is_array($j) ? ($j['models'] ?? []) : []) as $m) {        // LM Studio native, Gemini
            if (!is_array($m) || (isset($m['type']) && !in_array($m['type'], ['llm', 'vlm'], true))) {
                continue;
            }
            if (isset($m['supportedGenerationMethods']) && !in_array('generateContent', (array) $m['supportedGenerationMethods'], true)) {
                continue;
            }
            $id = (string) ($m['key'] ?? $m['id'] ?? preg_replace('#^models/#', '', (string) ($m['name'] ?? '')));
            if ($id !== '') {
                $models[$id] = ['id' => $id, 'label' => (string) ($m['display_name'] ?? $m['displayName'] ?? $id), 'loaded' => !empty($m['loaded_instances'])];
            }
        }
        foreach ((is_array($j) ? ($j['data'] ?? []) : []) as $m) {          // OpenAI shape
            $id = is_array($m) ? (string) ($m['id'] ?? '') : '';
            if ($id !== '' && !isset($models[$id]) && !preg_match('/embed/i', (string) ($m['type'] ?? ''))) {
                $models[$id] = ['id' => $id, 'label' => (string) ($m['display_name'] ?? $id), 'loaded' => ($m['state'] ?? '') === 'loaded'];
            }
        }
        $list = array_values($models);
        usort($list, static fn (array $a, array $b): int => [$b['loaded'], $a['id']] <=> [$a['loaded'], $b['id']]);
        aia_json(200, ['ok' => true, 'models' => $list]);
    }
    aia_json(200, ['ok' => false, 'code' => 'network', 'error' => aia_redact($lastError, $t['key'])]);
}

function aia_chat(array $t, array $req, array $cfg): void
{
    [$url, $body] = aia_chat_request($t, $req, $cfg);
    $public = $cfg['mode'] === 'public';
    $keepalive = (float) $cfg['keepalive'];
    aia_begin_stream($cfg['timeout']);

    $s = ['buffer' => '', 'status' => 0, 'errorBody' => '', 'produced' => false, 'streamError' => '', 'last' => microtime(true), 'gone' => false];

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
        CURLOPT_HTTPHEADER     => array_merge(aia_headers($t), ['Accept: text/event-stream']),
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT        => $cfg['timeout'],
        CURLOPT_HEADERFUNCTION => static function ($c, string $h) use (&$s): int {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
                $s['status'] = (int) $m[1];
            }
            return strlen($h);
        },
        // Called about once a second even while the model is silent (thinking): send a keepalive comment so Nginx's
        // fastcgi_read_timeout (60 s by default) and other proxies do not close the stream, and notice a visitor
        // who pressed Stop (PHP only learns that the connection is gone when a write fails).
        CURLOPT_NOPROGRESS       => false,
        CURLOPT_XFERINFOFUNCTION => static function ($c, $dlTotal, $dlNow, $ulTotal, $ulNow) use (&$s, $keepalive): int {
            if (microtime(true) - $s['last'] >= $keepalive) {
                aia_sse_comment('keepalive');
                $s['last'] = microtime(true);
            }
            if (connection_aborted()) {
                $s['gone'] = true;
                return 1;                                  // non-zero aborts the transfer
            }
            return 0;
        },
        CURLOPT_WRITEFUNCTION  => static function ($c, string $chunk) use (&$s, $t): int {
            if (connection_aborted()) {
                $s['gone'] = true;
                return 0;                                  // the browser went away (Stop): abort the upstream call
            }
            if ($s['status'] !== 200) {
                $s['errorBody'] .= substr($chunk, 0, max(0, 8000 - strlen($s['errorBody'])));
                return strlen($chunk);
            }
            $s['buffer'] .= str_replace("\r\n", "\n", $chunk);
            while (($pos = strpos($s['buffer'], "\n\n")) !== false) {
                $record = substr($s['buffer'], 0, $pos);
                $s['buffer'] = substr($s['buffer'], $pos + 2);
                foreach (explode("\n", $record) as $line) {
                    if (!str_starts_with($line, 'data:')) {
                        continue;
                    }
                    $payload = trim(substr($line, 5));
                    if ($payload === '' || $payload === '[DONE]') {
                        continue;
                    }
                    $event = json_decode($payload, true);
                    if (!is_array($event)) {
                        continue;
                    }
                    try {
                        foreach (aia_fragments($t['protocol'], $event) as [$type, $text]) {
                            $s['produced'] = true;
                            aia_sse($type === 'reasoning' ? 'reasoning' : 'delta', ['text' => $text]);
                            $s['last'] = microtime(true);
                        }
                    } catch (RuntimeException $e) {
                        $s['streamError'] = $e->getMessage();
                        return 0;
                    }
                }
            }
            return strlen($chunk);
        },
    ]);
    aia_curl_tls($ch, $cfg);
    curl_exec($ch);
    $errno = curl_errno($ch);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($s['gone']) {
        return;
    }
    if ($s['streamError'] !== '') {
        aia_stream_error(new AiaRelayError(502, 'refused', $public ? 'The model reported an error.' : aia_redact($s['streamError'], $t['key']), aia_redact($s['streamError'], $t['key'])));
        return;
    }
    if ($s['status'] !== 0 && $s['status'] !== 200) {
        $detail = aia_redact(aia_error_detail($s['errorBody']), $t['key']);
        $code = aia_code_for($s['status'], $detail);
        $full = $t['label'] . ' returned HTTP ' . $s['status'] . ($detail !== '' ? ': ' . $detail : '.');
        if ($public && $code === 'auth') {
            error_log('[ai-agent relay] ' . $full);
            aia_stream_error(AiaRelayError::misconfigured($full));
        } elseif ($public) {
            $msg = $code === 'rate-limit' ? 'The model provider is busy. Please try again in a moment.' : 'The model could not answer right now. Please try again.';
            aia_stream_error(new AiaRelayError(502, $code === 'missing-model' ? 'refused' : $code, $msg, $full));
        } else {
            aia_stream_error(new AiaRelayError(502, $code, $full));
        }
        return;
    }
    if ($errno !== 0) {
        $code = $errno === CURLE_OPERATION_TIMEDOUT ? 'timeout' : 'network';
        $full = 'Could not reach ' . $t['label'] . ' at ' . $t['baseUrl'] . ': ' . aia_redact($curlError, $t['key'])
            . ($errno === 60 || $errno === 77 ? ' — the server does not trust the provider\'s certificate: point curl.cainfo at a current https://curl.se/ca/cacert.pem, or set caBundle to \'native\' in the relay config (see references/providers.md).' : '');
        if ($public) {
            error_log('[ai-agent relay] ' . $full);
        }
        aia_stream_error(new AiaRelayError(502, $code, $public ? 'The model could not be reached right now. Please try again.' : $full, $full));
        return;
    }
    if (!$s['produced']) {
        aia_stream_error(new AiaRelayError(502, 'malformed', $t['label'] . ' returned no content.'));
        return;
    }
    aia_sse('done', ['provider' => $t['id'], 'model' => $t['model']]);
}

/** An error after the stream started: an SSE `error` event (with details only for requests from this computer). */
function aia_stream_error(AiaRelayError $e): void
{
    $data = ['message' => $e->getMessage(), 'code' => $e->errorCode];
    if ($e->detail !== '' && aia_is_local_request() && $e->detail !== $e->getMessage()) {
        $data['detail'] = $e->detail;
    }
    aia_sse('error', $data);
}

/* ------------------------------------------------------------------------------------------------- main */

function aia_main(): void
{
    $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    try {
        try {
            $cfg = aia_config();
        } catch (AiaRelayError $e) {
            if ($method === 'GET' || $method === 'HEAD') {
                error_log('[ai-agent relay] ' . $e->detail);
                aia_unavailable('', $e->getMessage(), $e->detail);
            }
            throw $e;
        }
        if ($method === 'GET' || $method === 'HEAD') {
            aia_info($cfg);
        }
        if ($method !== 'POST') {
            aia_json(405, ['ok' => false, 'error' => ['message' => 'Use POST.', 'code' => 'bad-endpoint']], ['Allow' => 'GET, POST']);
        }
        if ($cfg['mode'] === 'local' && !$cfg['allowRemote'] && !aia_is_local_request()) {
            throw new AiaRelayError(403, 'refused', 'This relay only answers requests from the computer it runs on.');
        }
        if ($cfg['mode'] === 'public') {
            aia_check_same_origin($cfg);
        }
        aia_authorize($cfg);

        $max = $cfg['limits']['maxBodyBytes'];
        $length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($max > 0 && $length > $max) {
            throw new AiaRelayError(413, 'budget', 'The request is too large for the assistant. Lower "Max screen content" or "Conversation memory" in Settings > Agent.');
        }
        $raw = file_get_contents('php://input', false, null, 0, $max > 0 ? $max + 1 : null);
        if (!is_string($raw) || ($max > 0 && strlen($raw) > $max)) {
            throw new AiaRelayError(413, 'budget', 'The request is too large for the assistant. Lower "Max screen content" or "Conversation memory" in Settings > Agent.');
        }
        $req = json_decode($raw, true);
        if (!is_array($req)) {
            throw new AiaRelayError(400, 'malformed', 'The request body was not valid JSON.');
        }

        $action = (string) ($req['action'] ?? 'chat');
        $target = aia_target($req, $cfg, $action === 'models');
        if ($action === 'models') {
            aia_models($target, $cfg);
        }
        aia_check_messages(is_array($req['messages'] ?? null) ? $req['messages'] : [], $cfg);   // before counting
        if ($cfg['mode'] === 'public') {
            aia_rate_limit($cfg);
        }
        aia_chat($target, $req, $cfg);
    } catch (AiaRelayError $e) {
        if ($e->detail !== '' && $e->status >= 500) {
            error_log('[ai-agent relay] ' . $e->detail);
        }
        if (headers_sent()) {
            aia_stream_error($e);
            return;
        }
        $error = ['message' => $e->getMessage(), 'code' => $e->errorCode];
        if ($e->detail !== '' && aia_is_local_request()) {
            $error['detail'] = $e->detail;
        }
        aia_json($e->status, ['ok' => false, 'error' => $error], $e->headers);
    }
}

if (!defined('AIA_RELAY_NO_MAIN')) {
    aia_main();
}
