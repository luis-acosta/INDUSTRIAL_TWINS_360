"""Modelo de permisos. ARCHIVO GENERADO: no editar a mano.

Lo genera "tools/emit-access-model.mjs" a partir de
"packages/domain/src/access.ts", que es la única fuente de verdad de los
permisos. Editar este archivo haría que el servidor concediera o negara cosas
distintas de las que la aplicación cree, y el desajuste no se vería probando la
interfaz: la interfaz oculta el botón, la API seguiría respondiendo.

"npm run verify" comprueba que esta copia corresponde al dominio actual.

Huella del modelo: dc1553b1c1dc33063925325b3689d9523bc371d3a78a63fd91c73a45d7f985c5
"""

from __future__ import annotations

from typing import Final

MODEL_FINGERPRINT: Final[str] = "dc1553b1c1dc33063925325b3689d9523bc371d3a78a63fd91c73a45d7f985c5"

OPERATIONS: Final[tuple[str, ...]] = (
    "project.read",
    "project.create",
    "project.update",
    "project.delete",
    "project.publish",
    "scene.read",
    "scene.update",
    "asset.read",
    "asset.update",
    "asset.import",
    "asset.export",
    "document.read",
    "document.upload",
    "document.approve",
    "note.read",
    "note.create",
    "note.update",
    "note.assign",
    "note.resolve",
    "note.delete",
    "telemetry.read",
    "telemetry.configure",
    "tour.read",
    "tour.update",
    "quiz.read",
    "quiz.update",
    "quiz.results.read",
    "skin.update",
    "user.read",
    "user.manage",
    "role.manage",
    "audit.read",
    "backup.create",
    "backup.restore",
    "script.approve",
    "settings.update",
)

ROLES: Final[tuple[str, ...]] = (
    "viewer",
    "contributor",
    "editor",
    "reviewer",
    "administrator",
)

ROLE_PERMISSIONS: Final[dict[str, frozenset[str]]] = {
    "viewer": frozenset(
        {
            "project.read",
            "scene.read",
            "asset.read",
            "document.read",
            "note.read",
            "telemetry.read",
            "tour.read",
            "quiz.read",
        }
    ),
    "contributor": frozenset(
        {
            "project.read",
            "scene.read",
            "asset.read",
            "document.read",
            "document.upload",
            "note.read",
            "note.create",
            "note.update",
            "telemetry.read",
            "tour.read",
            "quiz.read",
        }
    ),
    "editor": frozenset(
        {
            "project.read",
            "project.update",
            "scene.read",
            "scene.update",
            "asset.read",
            "asset.update",
            "asset.import",
            "asset.export",
            "document.read",
            "document.upload",
            "note.read",
            "note.create",
            "note.update",
            "note.assign",
            "note.resolve",
            "telemetry.read",
            "telemetry.configure",
            "tour.read",
            "tour.update",
            "quiz.read",
            "quiz.update",
            "quiz.results.read",
            "skin.update",
        }
    ),
    "reviewer": frozenset(
        {
            "project.read",
            "project.publish",
            "scene.read",
            "asset.read",
            "document.read",
            "document.approve",
            "note.read",
            "note.create",
            "note.update",
            "note.assign",
            "note.resolve",
            "telemetry.read",
            "tour.read",
            "quiz.read",
            "quiz.results.read",
            "audit.read",
        }
    ),
    "administrator": frozenset(
        {
            "project.read",
            "project.create",
            "project.update",
            "project.delete",
            "project.publish",
            "scene.read",
            "scene.update",
            "asset.read",
            "asset.update",
            "asset.import",
            "asset.export",
            "document.read",
            "document.upload",
            "document.approve",
            "note.read",
            "note.create",
            "note.update",
            "note.assign",
            "note.resolve",
            "note.delete",
            "telemetry.read",
            "telemetry.configure",
            "tour.read",
            "tour.update",
            "quiz.read",
            "quiz.update",
            "quiz.results.read",
            "skin.update",
            "user.read",
            "user.manage",
            "role.manage",
            "audit.read",
            "backup.create",
            "backup.restore",
            "script.approve",
            "settings.update",
        }
    ),
}
