from collections.abc import Callable
from typing import Any

from media_worker.job_context import JobContext
from media_worker.jobs import (
    find_clips,
    gen_footage,
    gen_narrate,
    gen_render,
    gen_script,
    ingest,
    package,
    reframe,
    render_short,
    thumbnail_mockup,
    transcribe,
)

JobRunner = Callable[[Any, JobContext], dict[str, Any]]

# Job types this worker handles (TECHNICAL_SPEC.md §6). Add new types here.
REGISTRY: dict[str, JobRunner] = {
    "media.ingest": ingest.run,
    "media.transcribe": transcribe.run,
    "ai.find_clips": find_clips.run,
    "media.reframe": reframe.run,
    "media.render_short": render_short.run,
    "ai.package": package.run,
    "media.thumbnail_mockup": thumbnail_mockup.run,
    "gen.script": gen_script.run,
    "gen.narrate": gen_narrate.run,
    "gen.footage": gen_footage.run,
    "gen.render": gen_render.run,
}
