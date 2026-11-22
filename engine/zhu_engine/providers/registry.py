"""AI models the app can ask: built-in providers, the user's own endpoints, and model selection.

Every provider is reached through its API, most with a key the user supplies. Eight built-in
providers can be used without payment (checked on 2026-11-20 against their own documentation:
Google Gemini, Groq, OpenRouter, SambaNova, NVIDIA NIM, Kilo Gateway, Z.ai, Pollinations); two of
them (Kilo Gateway, Pollinations) need no key at all. The limits are the providers' and can
change. A consumer chat subscription (ChatGPT Plus, Claude Pro…)
does not include API access; to use those accounts, the desktop app opens the provider's website
as a chat tab instead (apps/desktop/src-tauri/src/webchat.rs).

Besides the built-in ``custom`` entry, users can add any number of OpenAI-compatible endpoints
(local servers such as Ollama or LM Studio, gateways, other vendors). Their ids start with
``custom-``; an API key is optional for them, because local servers need none.

"Connect" in the UI is: store the key, list the provider's models, and pick one (``recommend_model``),
so that pasting a key is the only step. The user can choose another model from the list afterwards.
"""

from __future__ import annotations

import ipaddress
import re
import secrets
from dataclasses import asdict, dataclass, field
from typing import Optional
from urllib.parse import urlparse

from . import credentials
from .anthropic_adapter import DEFAULT_MODEL as CLAUDE_DEFAULT
from .anthropic_adapter import AnthropicAdapter
from .base import Capabilities, ProviderAdapter
from .openai_compat import OpenAICompatibleAdapter


@dataclass(frozen=True)
class ProviderDefinition:
    id: str
    name: str
    vendor: str
    default_base_url: Optional[str]
    default_model: Optional[str]
    default_images: bool
    keys_url: Optional[str]
    notes: str
    # API use without payment is available (the provider's limits apply and can change).
    free_tier: bool = False
    # False for user-defined endpoints: local servers (Ollama, LM Studio) accept requests without a key.
    key_required: bool = True
    # Model ids to prefer when choosing a model for the user, best first (regular expressions).
    prefer: tuple[str, ...] = ()
    # Only these models (a regular expression on the id) are free at a provider whose other models are
    # paid and whose model list carries no prices. None: the list's prices, or the free tier, decide.
    free_models: Optional[str] = None
    # The provider's model list says which models are free (a gateway with free and paid models).
    # False with free_tier: the free tier is the account's, so every chat model is offered on it.
    free_by_list: bool = False


DEFINITIONS: dict[str, ProviderDefinition] = {
    d.id: d
    for d in [
        ProviderDefinition("gemini", "Google Gemini", "Google", "https://generativelanguage.googleapis.com/v1beta/openai", None, True,
                           "https://aistudio.google.com/apikey", "Fast, and it can read screenshots. Free keys from Google AI Studio.",
                           free_tier=True, prefer=(r"gemini-[\d.]+-flash$", r"gemini-[\d.]+-flash(?!-lite)", r"gemini.*flash", r"gemini")),
        ProviderDefinition("groq", "Groq", "Groq", "https://api.groq.com/openai/v1", None, False,
                           "https://console.groq.com/keys", "Very fast answers from open models.",
                           free_tier=True, prefer=(r"gpt-oss-120b", r"gpt-oss", r"llama.*70b", r"qwen", r"llama")),
        ProviderDefinition("openrouter", "OpenRouter", "OpenRouter", "https://openrouter.ai/api/v1", None, False,
                           "https://openrouter.ai/keys", "One key for many models, including free ones.",
                           free_tier=True, free_by_list=True, prefer=(r"^openrouter/free$", r":free$")),
        ProviderDefinition("kilo", "Kilo Gateway", "Kilo", "https://ai-gateway.kilo.ai/api/v1", None, False,
                           "https://app.kilo.ai", "Free models without a key or an account. Their providers may log prompts: nothing sensitive.",
                           free_tier=True, free_by_list=True, key_required=False, prefer=(r"^kilo-auto/free$", r":free$")),
        ProviderDefinition("pollinations", "Pollinations", "Pollinations", "https://text.pollinations.ai/openai", None, False,
                           None, "A free public model without a key or an account. Nothing sensitive: it is an open service.",
                           free_tier=True, key_required=False),
        ProviderDefinition("sambanova", "SambaNova", "SambaNova", "https://api.sambanova.ai/v1", None, False,
                           "https://cloud.sambanova.ai/apis", "Fast open models. Free while no payment method is linked (about 20 requests a day).",
                           free_tier=True, prefer=(r"gpt-oss-120b", r"gemma", r"llama.*70b", r"llama")),
        ProviderDefinition("nvidia", "NVIDIA NIM", "NVIDIA", "https://integrate.api.nvidia.com/v1", None, False,
                           "https://build.nvidia.com", "Many open models, free for prototyping with an NVIDIA developer account.",
                           free_tier=True, prefer=(r"gpt-oss-120b", r"llama-[\d.]+-70b", r"qwen", r"llama")),
        ProviderDefinition("zai", "Z.ai (GLM)", "Z.ai", "https://api.z.ai/api/paas/v4", None, False,
                           "https://z.ai/manage-apikey/apikey-list", "GLM models. The GLM-4 Flash models are free; the others are paid.",
                           free_tier=True, free_models=r"glm-4(\.\d+)?v?-flash", prefer=(r"glm-4(\.\d+)?-flash",)),
        ProviderDefinition("chatgpt", "OpenAI", "OpenAI", "https://api.openai.com/v1", None, True,
                           "https://platform.openai.com/api-keys", "GPT models. Paid, and separate from ChatGPT Plus.",
                           prefer=(r"^gpt-[\d.]+$", r"^gpt-[\d.]+-mini$", r"^gpt-")),
        ProviderDefinition("claude", "Claude", "Anthropic", None, CLAUDE_DEFAULT, True,
                           "https://platform.claude.com/settings/keys", "Claude models. Paid, and separate from Claude Pro."),
        ProviderDefinition("deepseek", "DeepSeek", "DeepSeek", "https://api.deepseek.com", "deepseek-chat", False,
                           "https://platform.deepseek.com/api_keys", "DeepSeek chat models. Paid, low cost."),
        ProviderDefinition("grok", "Grok", "xAI", "https://api.x.ai/v1", None, True,
                           "https://console.x.ai", "Grok models. Paid, and separate from X Premium.",
                           prefer=(r"^grok-[\d.]+$", r"^grok-[\d.]+", r"^grok")),
        ProviderDefinition("custom", "Local model", "Custom", "http://localhost:11434/v1", None, False, None,
                           "A model on this computer (Ollama, LM Studio). No key needed.",
                           key_required=False),
    ]
}

CUSTOM_PREFIX = "custom-"
MAX_CUSTOM_PROVIDERS = 20
MAX_KNOWN_MODELS = 300
_CUSTOM_ID = re.compile(r"^custom-[a-z0-9]{6,16}$")

# Model ids that are not chat models (speech, embeddings, image/video generation, moderation…).
# Providers return these in the same list; asking them a question fails.
_NOT_CHAT = re.compile(
    r"whisper|tts|speech|transcri|audio|realtime|embed|rerank|moderation|guard|safeguard|orpheus|clip\b|imagen|image-generation|"
    r"-image\b|dall-e|veo|lyria|sora|ocr|aqa|robotics|-live\b|translate|computer-use", re.IGNORECASE)
_UNSTABLE = re.compile(r"preview|exp\b|experimental|beta|\d{4}-\d{2}-\d{2}|-\d{4}$", re.IGNORECASE)


def is_user_defined(pid: str) -> bool:
    """A provider the user added (removable), as opposed to a built-in definition."""
    return bool(_CUSTOM_ID.match(pid))


def validate_base_url(url: str) -> str:
    """Return the normalized base URL of an OpenAI-compatible endpoint, or raise ValueError."""
    url = (url or "").strip().rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("the address must be an http(s) URL, for example http://localhost:11434/v1")
    if parsed.username or parsed.password:
        raise ValueError("put the API key in the key field, not in the address")
    return url


def chat_models(pid: str, models: list[str]) -> list[str]:
    """The models worth offering in a chat app, most useful first.

    Non-chat models are dropped. On OpenRouter the free models come first, because its list is
    long (hundreds of entries) and most users are there for those.
    """
    out = [m for m in models if not _NOT_CHAT.search(m)]
    if pid == "openrouter":
        out.sort(key=lambda m: (0 if m == "openrouter/free" else 1 if m.endswith(":free") else 2, m))
    return out or list(models)


_FREE_ID = re.compile(r"(:free|[-/_]free)$", re.IGNORECASE)
_FREE_FLAGS = ("isFree", "is_free", "free")
_PRICE_KEY = re.compile(r"prompt|completion|input|output", re.IGNORECASE)
_PRICE_FIELD = re.compile(r"(prompt|completion|input|output).*(price|cost)|(price|cost).*(prompt|completion|input|output)", re.IGNORECASE)


def _number(value) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip().lstrip("$"))
        except ValueError:
            return None
    return None


def _token_prices(entry: dict) -> list[float]:
    """The per-token prices a model list entry states, whatever shape the provider uses.

    Seen in the wild: ``pricing: {prompt, completion}`` (OpenRouter and gateways modelled on it),
    ``pricing: {input, output}``, ``metadata.pricing: {input_tokens, output_tokens}``, and
    top-level fields such as ``input_token_price_per_m``.
    """
    prices: list[float] = []
    metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
    for block in (entry.get("pricing"), entry.get("price"), entry.get("cost"), metadata.get("pricing")):
        if isinstance(block, dict):
            prices += [n for k, v in block.items() if _PRICE_KEY.search(str(k)) and (n := _number(v)) is not None]
    prices += [n for k, v in entry.items() if _PRICE_FIELD.search(str(k)) and (n := _number(v)) is not None]
    return prices


def model_is_free(entry: dict) -> Optional[bool]:
    """True when the entry says the model costs nothing, False when it has a price, None when it does not say.

    An explicit flag (``isFree``, or a "free" tag) is believed first, then stated prices, then the
    id. A negative price means "varies" (a router that picks a model per request) and counts as paid.
    """
    for flag in _FREE_FLAGS:
        if isinstance(entry.get(flag), bool):
            return entry[flag]
    tags = entry.get("tags")
    if isinstance(tags, list) and any(str(t).lower() == "free" for t in tags):
        return True
    prices = _token_prices(entry)
    if prices:
        return all(p == 0 for p in prices)
    return True if _FREE_ID.search(str(entry.get("id") or "")) else None


# What a model can be given besides text, in the order the picker shows it.
INPUT_KINDS = ("image", "file", "audio", "video")


def model_inputs(entry: dict) -> Optional[list[str]]:
    """What a model list entry says the model takes besides text (of ``INPUT_KINDS``); None when it does not say.

    An empty list is a text-only model. Seen in the wild: ``architecture.input_modalities:
    ["text", "image", "file"]`` and ``architecture.modality: "text+image->text"`` (OpenRouter and
    gateways modelled on it), and the same fields at the top level.
    """
    for block in (entry.get("architecture"), entry):
        if not isinstance(block, dict):
            continue
        inputs = block.get("input_modalities")
        modality = block.get("modality")
        if isinstance(inputs, list) and inputs:
            stated = {str(i).lower() for i in inputs}
        elif isinstance(modality, str) and "->" in modality:
            stated = {part.strip() for part in modality.split("->")[0].lower().split("+")}
        else:
            continue
        return [kind for kind in INPUT_KINDS if kind in stated]
    return None


def model_reads_images(entry: dict) -> Optional[bool]:
    """True when a model list entry says the model takes images, False when it lists its inputs without them, None when it does not say."""
    inputs = model_inputs(entry)
    return None if inputs is None else "image" in inputs


def is_local_address(url: Optional[str]) -> bool:
    """An address on this computer or the user's own network: a model the user runs, with no per-use price."""
    host = (urlparse(url or "").hostname or "").lower()
    if host == "localhost" or host.endswith((".localhost", ".local")):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private


def detect_free_models(definition: ProviderDefinition, base_url: Optional[str], entries: list[dict]) -> tuple[list[str], str]:
    """Which of a provider's chat models can be used without paying, and how that was decided.

    Returns ``(model ids, basis)``; the basis is shown to the user:
      * ``listed``    — the provider's model list marks them (a zero price, or an id ending in ":free")
      * ``free_tier`` — the provider has a free tier for its models (its limits apply)
      * ``local``     — the models run on the user's own computer or network
      * ``unknown``   — the list carries no prices, so nothing can be said
    """
    ids = [str(e["id"]) for e in entries if e.get("id")]
    chat = chat_models(definition.id, ids)
    if definition.free_models:
        rx = re.compile(definition.free_models, re.IGNORECASE)
        return [m for m in chat if rx.search(m)], "listed"
    if definition.free_tier and not definition.free_by_list:
        return chat, "free_tier"
    verdicts = {str(e["id"]): model_is_free(e) for e in entries if e.get("id")}
    if any(v is not None for v in verdicts.values()):
        return [m for m in chat if verdicts.get(m)], "listed"
    if is_local_address(base_url):
        return chat, "local"
    return [], "unknown"


def _version(model_id: str) -> tuple:
    """Numeric parts of a model id, so "…-3.8-…" sorts above "…-3.5-…"."""
    return tuple(float(n) for n in re.findall(r"\d+(?:\.\d+)?", model_id.split("/")[-1])[:3])


def recommend_model(definition: ProviderDefinition, models: list[str], free: Optional[list[str]] = None) -> Optional[str]:
    """Choose a model for the user from what the provider lists (never a hard-coded id, which goes stale).

    The first preference pattern that matches anything wins; among its matches stable ids beat
    preview or dated ones, then the highest version wins. When only some of the models are free
    (``free``), the choice is made among those, so connecting never selects a model that costs
    money by itself. A provider without preferences (a local server) gets its first model.
    Returns None when the user has to choose.
    """
    candidates = chat_models(definition.id, models)
    if free:
        candidates = [m for m in candidates if m in set(free)] or candidates
    if not candidates:
        return None
    for pattern in definition.prefer:
        rx = re.compile(pattern, re.IGNORECASE)
        hits = [m for m in candidates if rx.search(m.split("models/")[-1])]
        if hits:
            stable = [m for m in hits if not _UNSTABLE.search(m)]
            return max(stable or hits, key=lambda m: (_version(m), -len(m)))
    return candidates[0] if free or not definition.key_required or len(candidates) == 1 else None


def _custom_definition(pid: str, name: str, base_url: Optional[str]) -> ProviderDefinition:
    return ProviderDefinition(pid, name, "Custom", base_url, None, False, None, "Your own OpenAI-compatible model.", key_required=False)


@dataclass
class ProviderConfig:
    enabled: bool = True
    model: Optional[str] = None
    base_url: Optional[str] = None
    images: Optional[bool] = None  # None = definition default
    effort: str = "medium"  # Claude only
    use_fallbacks: bool = True  # Claude only: server-side refusal fallback
    display_name: Optional[str] = None
    include_history: bool = True
    known_models: list[str] = field(default_factory=list)
    # The known models that cost nothing to use, and how that was decided (see detect_free_models).
    free_models: list[str] = field(default_factory=list)
    free_basis: Optional[str] = None
    # The known models that read images, when the provider's model list says which do (a gateway
    # has both kinds). None: the list does not say, and `images` decides for all of its models.
    image_models: Optional[list[str]] = None
    # For the same models, everything they take besides text (see model_inputs), for the model
    # picker: {"model id": ["image", "file"]}, an empty list for a text-only model. None as above.
    model_inputs: Optional[dict[str, list[str]]] = None

    def to_dict(self) -> dict:
        return asdict(self)


class ProviderRegistry:
    def __init__(self, configs: dict[str, dict]) -> None:
        # Built-in definitions plus the endpoints the user added (ids "custom-…"), in a stable order.
        self.definitions: dict[str, ProviderDefinition] = dict(DEFINITIONS)
        self.configs: dict[str, ProviderConfig] = {}
        for pid in DEFINITIONS:
            self.configs[pid] = self._config(configs.get(pid, {}))
        for pid, raw in configs.items():
            if is_user_defined(pid) and isinstance(raw, dict):
                cfg = self._config(raw)
                self.configs[pid] = cfg
                self.definitions[pid] = _custom_definition(pid, cfg.display_name or "My model", cfg.base_url)
        self._adapters: dict[str, ProviderAdapter] = {}
        # Providers whose model list has been read in this run (see learn_image_models).
        self._images_learned: set[str] = set()

    @staticmethod
    def _config(raw: dict) -> ProviderConfig:
        return ProviderConfig(**{k: v for k, v in raw.items() if k in ProviderConfig.__dataclass_fields__})

    def serialize_configs(self) -> dict[str, dict]:
        return {pid: c.to_dict() for pid, c in self.configs.items()}

    # ------------------------------------------------------------------ user-defined endpoints
    def add_custom(self, name: str, base_url: str, model: Optional[str] = None, images: bool = False) -> str:
        name = " ".join((name or "").split())
        if not name:
            raise ValueError("give the model a name")
        base_url = validate_base_url(base_url)
        if sum(1 for pid in self.definitions if is_user_defined(pid)) >= MAX_CUSTOM_PROVIDERS:
            raise ValueError(f"at most {MAX_CUSTOM_PROVIDERS} models can be added")
        pid = CUSTOM_PREFIX + secrets.token_hex(4)
        while pid in self.definitions:
            pid = CUSTOM_PREFIX + secrets.token_hex(4)
        self.configs[pid] = ProviderConfig(display_name=name[:60], base_url=base_url, model=(model or "").strip() or None, images=images)
        self.definitions[pid] = _custom_definition(pid, name[:60], base_url)
        return pid

    async def remove_custom(self, pid: str) -> None:
        if not is_user_defined(pid) or pid not in self.definitions:
            raise KeyError(pid)
        await self.reset_adapter(pid)
        credentials.delete_api_key(pid)
        del self.definitions[pid]
        del self.configs[pid]

    # ------------------------------------------------------------------ status
    def remember_models(self, pid: str, models: list[str], entries: Optional[list[dict]] = None) -> Optional[str]:
        """Store the provider's model list after a successful connection, and choose a model when none is set.

        ``entries`` are the raw items of the provider's model list (with prices, where it states
        them); the free models are worked out from them. Returns the model now selected, or None
        when the user has to choose one.
        """
        d, c = self.definitions[pid], self.configs[pid]
        free, basis = detect_free_models(d, c.base_url or d.default_base_url, entries or [{"id": m} for m in models])
        known = chat_models(pid, models)
        if 0 < len(free) < len(known):  # the free ones first: lists can have hundreds of entries
            chosen = set(free)
            known = free + [m for m in known if m not in chosen]
        c.known_models = known[:MAX_KNOWN_MODELS]
        c.free_models = free[:MAX_KNOWN_MODELS]
        c.free_basis = basis
        inputs = {str(e["id"]): model_inputs(e) for e in (entries or []) if e.get("id")}
        stated = {m: inputs[m] for m in c.known_models if inputs.get(m) is not None}
        c.model_inputs = stated or None
        c.image_models = [m for m in c.known_models if "image" in stated.get(m, ())] if stated else None
        self._images_learned.add(pid)
        if not (c.model or d.default_model):
            c.model = recommend_model(d, models, free if len(free) < len(known) else None)
        return c.model or d.default_model

    def _free_models(self, pid: str) -> tuple[list[str], Optional[str]]:
        """The stored free models; for a provider connected before they were recorded, worked out from the ids."""
        d, c = self.definitions[pid], self.configs[pid]
        if c.free_basis or not c.known_models:
            return c.free_models, c.free_basis
        return detect_free_models(d, c.base_url or d.default_base_url, [{"id": m} for m in c.known_models])

    def info(self, pid: str) -> dict:
        d = self.definitions[pid]
        c = self.configs[pid]
        has_key = credentials.has_api_key(pid)
        model = c.model or d.default_model
        if not c.enabled:
            status, message = "disabled", "Switched off."
        elif not (has_key or not d.key_required):
            status, message = "not_configured", "Add an API key in Settings to use this model."
        elif not model:
            status, message = "needs_model", "Press Connect in Settings to choose a model."
        else:
            status, message = "ready", "Connected."
        definition = asdict(d)
        for internal in ("prefer", "free_models", "free_by_list"):
            definition.pop(internal)
        free, basis = self._free_models(pid)
        return {
            **definition,
            "name": c.display_name or d.name,
            "user_defined": is_user_defined(pid),
            "status": status,
            "status_message": message,
            "has_api_key": has_key,
            "api_key_hint": credentials.mask(credentials.get_api_key(pid)) if has_key else None,
            "capabilities": self.capabilities(pid, model).to_dict(),
            "config": {**c.to_dict(), "free_models": free, "free_basis": basis},
            "model": model,
        }

    def reads_images(self, pid: str, model: Optional[str] = None) -> bool:
        """Whether images are sent to this model (the provider's selected model when none is given).

        The provider's model list decides for the models it describes: a gateway offers models that
        read images next to models that reject them. For every other model the provider's own
        switch decides (``images``, by default what the definition says).
        """
        d, c = self.definitions[pid], self.configs[pid]
        if pid == "claude":
            return True
        model = model or c.model or d.default_model
        if c.model_inputs is not None and model in c.model_inputs:
            return "image" in c.model_inputs[model]
        if c.image_models is not None and model in c.known_models:  # stored before model_inputs existed
            return model in c.image_models
        return d.default_images if c.images is None else c.images

    def capabilities(self, pid: str, model: Optional[str] = None) -> Capabilities:
        if pid == "claude":
            return Capabilities(True, True, True, True, True, 20)
        images = self.reads_images(pid, model)
        return Capabilities(True, images, True, True, True, 10 if images else 0)

    async def learn_image_models(self, pid: str) -> bool:
        """Read the provider's model list once per run, when it is not yet known which of its models read images.

        A provider connected before this was recorded has no such list. It is asked at the moment
        images are about to be sent to it, so a text-only model is refused here with a clear
        message and not by the provider with "not found". Returns True when the stored
        configuration changed. A provider that cannot be reached leaves things as they were.
        """
        c = self.configs[pid]
        if pid == "claude" or pid in self._images_learned or c.model_inputs is not None:
            return False
        self._images_learned.add(pid)
        adapter = self.adapter(pid)
        if not isinstance(adapter, OpenAICompatibleAdapter):
            return False
        try:
            entries = await adapter.list_model_entries()
        except Exception:  # noqa: BLE001 - the request that follows reports what is wrong
            return False
        self.remember_models(pid, [e["id"] for e in entries], entries)
        return True

    def adapter(self, pid: str) -> ProviderAdapter:
        if pid in self._adapters:
            return self._adapters[pid]
        d, c = self.definitions[pid], self.configs[pid]
        key = credentials.get_api_key(pid)
        if pid == "claude":
            a: ProviderAdapter = AnthropicAdapter(key, effort=c.effort, use_fallbacks=c.use_fallbacks)
        else:
            images = d.default_images if c.images is None else c.images
            a = OpenAICompatibleAdapter(pid, c.display_name or d.name, c.base_url or d.default_base_url or "", key, images, c.model or d.default_model,
                                        require_key=d.key_required, reads_images=lambda model, pid=pid: self.reads_images(pid, model))
        self._adapters[pid] = a
        return a

    async def reset_adapter(self, pid: str) -> None:
        a = self._adapters.pop(pid, None)
        if a is not None:
            await a.dispose()

    async def dispose(self) -> None:
        for pid in list(self._adapters):
            await self.reset_adapter(pid)
