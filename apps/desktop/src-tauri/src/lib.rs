//! Contenedor de escritorio de INDUSTRIAL TWINS 360.
//!
//! El criterio de reparto entre Rust y TypeScript es el del plan: en Rust sólo
//! lo que la vista web no puede hacer, o no debe. Eso son cuatro cosas:
//!
//!  - el volcado a disco (`fsync`), que el complemento `fs` no expone y sin el
//!    cual el guardado atómico no garantiza nada;
//!  - el almacén de credenciales del sistema, para que el token de telemetría
//!    no pase por la vista web;
//!  - el proxy de telemetría, que es quien usa ese token;
//!  - la información del contenedor, para que la aplicación sepa si corre
//!    empaquetada y con qué versión.
//!
//! Todo lo demás —modelo, validación, persistencia, publicación— está en
//! TypeScript y cubierto por pruebas que se ejecutan sin compilar Rust. Mover
//! lógica aquí la haría más difícil de probar sin ganar nada.

mod secrets;
mod telemetry;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                // Los registros van a archivo y a la consola de depuración,
                // nunca a la vista web: un registro accesible desde la vista
                // es un registro que un script del proyecto podría leer.
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            fsync_path,
            shell_info,
            secrets::secret_set,
            secrets::secret_exists,
            secrets::secret_delete,
            telemetry::telemetry_query,
            telemetry::telemetry_ping,
        ])
        .run(tauri::generate_context!())
        .expect("El contenedor de la aplicación no pudo arrancar");
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
}
