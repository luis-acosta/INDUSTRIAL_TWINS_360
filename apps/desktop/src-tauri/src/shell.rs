//! Comandos del contenedor: volcado a disco e información de la aplicación.
//!
//! Viven en su propio módulo, como `secrets` y `telemetry`, y no en la raíz de
//! la biblioteca. No es una cuestión de orden: `#[tauri::command]` genera un
//! elemento auxiliar junto a cada función, y `generate_handler!` genera otro
//! con el mismo nombre en el ámbito donde se invoca. Si la función y la
//! invocación comparten ámbito —que es lo que pasa cuando ambas están en la
//! raíz— los dos elementos chocan y la compilación falla con E0255. Citando el
//! comando por su módulo, como ya se hacía con los otros cinco, el conflicto
//! no existe.

use serde::Serialize;
use std::fs::OpenOptions;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum ShellError {
    #[error("Ruta no admitida: {0}")]
    InvalidPath(String),
    #[error("No se pudo volcar a disco: {0}")]
    Io(String),
}

impl Serialize for ShellError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Rechaza rutas relativas y rutas con `..`.
///
/// El comando recibe la ruta de la vista web. Aunque el alcance del
/// complemento `fs` ya limita las carpetas accesibles, este comando abre el
/// archivo por su cuenta y por tanto necesita su propia comprobación: un
/// `..` encadenado podría salir de la carpeta pretendida.
fn checked_path(raw: &str) -> Result<PathBuf, ShellError> {
    let path = Path::new(raw);

    if !path.is_absolute() {
        return Err(ShellError::InvalidPath(format!("{raw} no es absoluta")));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(ShellError::InvalidPath(format!("{raw} contiene ..")));
    }
    Ok(path.to_path_buf())
}

/// Vuelca a disco los datos pendientes de un archivo ya escrito.
///
/// Es el paso que convierte «escribí el temporal» en «el temporal está en el
/// disco». Sin él, el renombrado posterior puede completarse mientras el
/// contenido sigue en la caché del sistema, y un corte de corriente en ese
/// instante deja el archivo con el nombre definitivo y el contenido a medias:
/// precisamente el fallo que el guardado atómico existe para evitar.
#[tauri::command]
pub fn fsync_path(path: String) -> Result<(), ShellError> {
    let path = checked_path(&path)?;
    let file = OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|e| ShellError::Io(e.to_string()))?;
    file.sync_all().map_err(|e| ShellError::Io(e.to_string()))
}

#[derive(Debug, Serialize)]
pub struct ShellInfo {
    pub app_version: String,
    pub tauri_version: String,
    pub platform: String,
    /// `true` cuando corre desde el instalador y no desde `tauri dev`.
    pub packaged: bool,
}

#[tauri::command]
pub fn shell_info() -> ShellInfo {
    ShellInfo {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        tauri_version: tauri::VERSION.to_string(),
        platform: std::env::consts::OS.to_string(),
        packaged: !cfg!(debug_assertions),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rechaza_rutas_relativas() {
        assert!(checked_path("proyecto.ivp").is_err());
    }

    #[test]
    fn rechaza_rutas_con_padre() {
        // La ruta es absoluta y aun así sale de la carpeta pretendida.
        assert!(checked_path("/datos/proyectos/../../etc/passwd").is_err());
    }

    #[test]
    fn acepta_una_ruta_absoluta_normal() {
        #[cfg(windows)]
        assert!(checked_path(r"C:\Proyectos\planta.ivp").is_ok());
        #[cfg(not(windows))]
        assert!(checked_path("/home/usuario/planta.ivp").is_ok());
    }

    #[test]
    fn la_informacion_del_contenedor_se_rellena() {
        // Sin esto, un campo vacío llegaría a la pantalla «Acerca de» y nadie
        // sabría de qué versión es la copia que está usando.
        let info = shell_info();
        assert!(!info.app_version.is_empty());
        assert!(!info.tauri_version.is_empty());
        assert!(!info.platform.is_empty());
    }

    #[test]
    fn el_error_se_serializa_como_texto_legible() {
        // Llega a la vista web y acaba en un aviso que lee una persona.
        let error = ShellError::InvalidPath("/x/../y".to_string());
        let json = serde_json::to_string(&error).expect("debe serializar");
        assert!(json.contains("Ruta no admitida"));
    }
}
