<?php
declare(strict_types=1);

/**
 * ai-agent-drawer — PHP relay
 * ---------------------------
 * Drop this file into a PHP application (XAMPP/Apache, nginx+php-fpm, `php -S`) and point the agent at it:
 *   createAiAgent({ defaults: { transport: 'relay', relayUrl: 'relay.php' } })
 * or let users switch to it in Settings > Model > Advanced.
 *
 * The browser sends the conversation here; this file calls the provider with cURL and streams the reply back as
 * Server-Sent Events. It speaks the same contract as assets/ai-agent/adapters/relay.js:
 *
 *   POST {action:'chat', provider, baseUrl, model, apiKey, system, messages:[{role,content}], maxTokens,
 *         temperature, reasoning}
 *     -> text/event-stream: delta {text} | reasoning {text} | status {message} | error {message, code} | done {…}
 *   POST {action:'models', provider, baseUrl, apiKey} -> {ok, models:[{id,label,loaded}]} | {ok:false, error}
 *   GET  -> {ok, relay, providers, serverKeys}
 *
 * Keys: the request's apiKey if the user typed one, otherwise the environment variable named in the catalog
 * (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY), otherwise the
 * AIA_KEYS array below.
 *
 * Safety defaults: answers only requests from this computer (AIA_ALLOW_REMOTE); cloud providers always use their
 * catalog address, local providers may only target loopback/private hosts (AIA_ALLOW_ANY_UPSTREAM); bodies are
 * capped. If your app has authentication/CSRF, check it where marked below.
 */

const AIA_ALLOW_REMOTE = false;        // true: accept requests from other machines (put auth in front of it first!)
const AIA_ALLOW_ANY_UPSTREAM = false;  // true: local/custom providers may target any host
const AIA_MAX_BODY = 4 * 1024 * 1024;
const AIA_TIMEOUT = 300;               // seconds for one reply
const AIA_KEYS = [
    // 'openai' => 'sk-…',             // server-side keys, if you prefer this to environment variables
];

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

/* ------------------------------------------------------------------------------------------------ helpers */

function aia_json(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function aia_sse(string $event, array $data): void
{
    echo 'event: ' . $event . "\n";
    echo 'data: ' . json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) . "\n\n";
    @flush();
}

function aia_is_local_request(): bool
{
    $addr = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    return $addr === '::1' || str_starts_with($addr, '127.') || str_starts_with($addr, '::ffff:127.');
}

function aia_is_local_url(string $url): bool
{
    $host = strtolower(trim((string) parse_url($url, PHP_URL_HOST), '[]'));
    if ($host === '' ) {
        return false;
    }
    if (in_array($host, ['localhost', '::1', '0.0.0.0'], true) || str_ends_with($host, '.localhost') || str_ends_with($host, '.local')) {
        return true;
    }
    if (!preg_match('/^(\d+)\.(\d+)\.\d+\.\d+$/', $host, $m)) {
        return false;
    }
    $a = (int) $m[1];
    $b = (int) $m[2];
    return $a === 127 || $a === 10 || ($a === 192 && $b === 168) || ($a === 172 && $b >= 16 && $b <= 31);
}

function aia_redact(string $text, string $key): string
{
    if (strlen($key) >= 4) {
        $text = str_replace($key, '[redacted]', $text);
    }
    return (string) preg_replace('/(bearer\s+|x-api-key:\s*|key=)[^\s"&]+/i', '$1[redacted]', $text);
}

function aia_join(string $base, string $path): string
{
    $base = rtrim($base, '/');
    if (preg_match('#^/v1(beta)?/#', $path, $m) && str_ends_with($base, rtrim($m[0], '/'))) {
        $base = substr($base, 0, -strlen(rtrim($m[0], '/')));
    }
    return $base . $path;
}

/** @return array<string, mixed> */
function aia_target(array $req): array
{
    $id = (string) ($req['provider'] ?? '');
    if (!isset(AIA_PROVIDERS[$id])) {
        throw new RuntimeException('Unknown provider "' . $id . '".');
    }
    $p = AIA_PROVIDERS[$id];
    $base = $p['base'];
    $wanted = trim((string) ($req['baseUrl'] ?? ''));
    if ($wanted !== '' && $p['kind'] !== 'cloud') {
        if (!preg_match('#^https?://#i', $wanted)) {
            throw new RuntimeException('The server address must start with http:// or https://.');
        }
        if (!AIA_ALLOW_ANY_UPSTREAM && !aia_is_local_url($wanted)) {
            throw new RuntimeException('This relay only forwards ' . $p['label'] . ' requests to local/private addresses.');
        }
        $base = $wanted;
    }
    $key = trim((string) ($req['apiKey'] ?? ''));
    if ($key === '' && $p['env'] !== '') {
        $key = (string) (getenv($p['env']) ?: '');
    }
    if ($key === '' && isset(AIA_KEYS[$id])) {
        $key = (string) AIA_KEYS[$id];
    }
    if ($p['kind'] === 'cloud' && $key === '') {
        throw new RuntimeException($p['label'] . ' needs an API key: type one in Settings, or set ' . $p['env'] . ' on the server.');
    }
    return $p + ['id' => $id, 'baseUrl' => rtrim($base, '/'), 'key' => $key, 'model' => trim((string) ($req['model'] ?? ''))];
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

/** @return array{0: string, 1: array<string, mixed>} url and body */
function aia_chat_request(array $t, array $req): array
{
    $system = (string) ($req['system'] ?? '');
    $messages = aia_messages(is_array($req['messages'] ?? null) ? $req['messages'] : []);
    $maxTokens = max(64, min(64000, (int) ($req['maxTokens'] ?? 2048)));
    $temperature = is_numeric($req['temperature'] ?? null) ? (float) $req['temperature'] : 0.4;
    $reasoningOff = ($req['reasoning'] ?? '') === 'off';

    if ($t['protocol'] === 'anthropic') {
        if ($t['model'] === '') {
            throw new RuntimeException('Choose an Anthropic model in Settings.');
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
            throw new RuntimeException('Choose a Gemini model in Settings.');
        }
        $body = [
            'contents' => array_map(static fn (array $m): array => ['role' => $m['role'] === 'assistant' ? 'model' : 'user', 'parts' => [['text' => $m['content']]]], $messages),
            'generationConfig' => ['maxOutputTokens' => $maxTokens, 'temperature' => $temperature],
        ];
        if ($system !== '') {
            $body['systemInstruction'] = ['parts' => [['text' => $system]]];
        }
        $path = str_replace('{model}', rawurlencode(preg_replace('#^models/#', '', $t['model'])), $t['chat']);
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

function aia_models(array $t): void
{
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
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false || $status !== 200) {
            $lastError = $body === false ? ($err ?: 'Could not connect.') : ('HTTP ' . $status . ' ' . aia_error_detail((string) $body));
            continue;
        }
        $j = json_decode((string) $body, true);
        $models = [];
        foreach (($j['models'] ?? []) as $m) {           // LM Studio native, Gemini
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
        foreach (($j['data'] ?? []) as $m) {             // OpenAI shape
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

function aia_chat(array $t, array $req): void
{
    [$url, $body] = aia_chat_request($t, $req);

    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    @ini_set('zlib.output_compression', '0');
    @ini_set('implicit_flush', '1');
    set_time_limit(AIA_TIMEOUT + 30);
    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Accel-Buffering: no');

    $buffer = '';
    $status = 0;
    $errorBody = '';
    $produced = false;
    $inStreamError = '';

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        CURLOPT_HTTPHEADER     => array_merge(aia_headers($t), ['Accept: text/event-stream']),
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT        => AIA_TIMEOUT,
        CURLOPT_HEADERFUNCTION => static function ($c, string $h) use (&$status): int {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
                $status = (int) $m[1];
            }
            return strlen($h);
        },
        CURLOPT_WRITEFUNCTION  => static function ($c, string $chunk) use (&$buffer, &$status, &$errorBody, &$produced, &$inStreamError, $t): int {
            if (connection_aborted()) {
                return 0; // the browser went away (Stop): abort the upstream call
            }
            if ($status !== 200) {
                $errorBody .= substr($chunk, 0, 8000 - strlen($errorBody));
                return strlen($chunk);
            }
            $buffer .= str_replace("\r\n", "\n", $chunk);
            while (($pos = strpos($buffer, "\n\n")) !== false) {
                $record = substr($buffer, 0, $pos);
                $buffer = substr($buffer, $pos + 2);
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
                            $produced = true;
                            aia_sse($type === 'reasoning' ? 'reasoning' : 'delta', ['text' => $text]);
                        }
                    } catch (RuntimeException $e) {
                        $inStreamError = $e->getMessage();
                        return 0;
                    }
                }
            }
            return strlen($chunk);
        },
    ]);
    curl_exec($ch);
    $errno = curl_errno($ch);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($inStreamError !== '') {
        aia_sse('error', ['message' => aia_redact($inStreamError, $t['key']), 'code' => 'refused']);
        return;
    }
    if ($status !== 0 && $status !== 200) {
        $detail = aia_error_detail($errorBody);
        aia_sse('error', ['message' => $t['label'] . ' returned HTTP ' . $status . ($detail !== '' ? ': ' . aia_redact($detail, $t['key']) : '.'), 'code' => aia_code_for($status, $detail)]);
        return;
    }
    if ($errno !== 0 && !connection_aborted()) {
        $code = $errno === CURLE_OPERATION_TIMEDOUT ? 'timeout' : 'network';
        aia_sse('error', ['message' => 'Could not reach ' . $t['label'] . ' at ' . $t['baseUrl'] . ': ' . aia_redact($curlError, $t['key']), 'code' => $code]);
        return;
    }
    if (!$produced) {
        aia_sse('error', ['message' => $t['label'] . ' returned no content.', 'code' => 'malformed']);
        return;
    }
    aia_sse('done', ['provider' => $t['id'], 'model' => $t['model']]);
}

/* ------------------------------------------------------------------------------------------------- main */

if (!AIA_ALLOW_REMOTE && !aia_is_local_request()) {
    aia_json(403, ['error' => ['message' => 'This relay only answers requests from this computer.']]);
}

// If the application has sign-in or CSRF protection, enforce it here, e.g.:
//   require __DIR__ . '/auth.php'; require_login(); check_csrf($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if ($method === 'GET') {
    $keys = [];
    foreach (AIA_PROVIDERS as $id => $p) {
        if ($p['env'] !== '') {
            $keys[$id] = (getenv($p['env']) ?: '') !== '' || isset(AIA_KEYS[$id]);
        }
    }
    aia_json(200, ['ok' => true, 'relay' => 'ai-agent-drawer', 'providers' => array_keys(AIA_PROVIDERS), 'serverKeys' => $keys]);
}
if ($method !== 'POST') {
    aia_json(405, ['error' => ['message' => 'Use POST.']]);
}

$raw = file_get_contents('php://input', false, null, 0, AIA_MAX_BODY + 1);
if ($raw === false || strlen($raw) > AIA_MAX_BODY) {
    aia_json(413, ['error' => ['message' => 'The request body is too large.']]);
}
$req = json_decode($raw, true);
if (!is_array($req)) {
    aia_json(400, ['error' => ['message' => 'The request body was not valid JSON.']]);
}

try {
    $target = aia_target($req);
    if (($req['action'] ?? 'chat') === 'models') {
        aia_models($target);
    }
    aia_chat($target, $req);
} catch (RuntimeException $e) {
    if (headers_sent()) {
        aia_sse('error', ['message' => $e->getMessage(), 'code' => 'refused']);
    } else {
        aia_json(400, ['ok' => false, 'error' => ['message' => $e->getMessage(), 'code' => 'refused']]);
    }
}
