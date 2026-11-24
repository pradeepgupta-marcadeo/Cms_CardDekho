// The rich-text editor for article bodies (CKEditor 5, GPL build: no licence key, no paid features).
// The HTML it writes goes into the hidden #body_html field and is sanitised again on the server.
const host = document.querySelector("[data-editor-host]");
const field = document.getElementById("body_html");
const csrf = document.querySelector('meta[name="csrf"]')?.content ?? "";
const CK = window.CKEDITOR;

if (host && field) {
  if (!CK) {
    host.innerHTML = '<p class="err">The editor could not load. Reload the page; if it keeps failing, check that <code>/static/vendor/ckeditor5</code> is reachable.</p>';
  } else {
    // Dropped or pasted pictures go to the media library, never into the text as huge base64 blobs.
    class UploadAdapter {
      constructor(loader) {
        this.loader = loader;
      }
      async upload() {
        const file = await this.loader.file;
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/admin/media/upload", { method: "POST", body: form, headers: { "x-csrf-token": csrf, accept: "application/json" } });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || "Image upload failed");
        return { default: json.url };
      }
      abort() {}
    }
    // A plain function, not an arrow: CKEditor builds plugins with `new`.
    function UploadPlugin(editor) {
      editor.plugins.get("FileRepository").createUploadAdapter = (loader) => new UploadAdapter(loader);
    }

    host.replaceChildren();
    CK.ClassicEditor.create(host, {
      licenseKey: "GPL",
      initialData: field.value,
      placeholder: "Write your content here…",
      plugins: [
        CK.Essentials, CK.Autoformat, CK.Paragraph, CK.Heading,
        CK.Bold, CK.Italic, CK.Underline, CK.Strikethrough, CK.RemoveFormat,
        CK.List, CK.Alignment, CK.BlockQuote, CK.HorizontalLine,
        CK.Link, CK.AutoLink, CK.LinkImage,
        CK.Image, CK.ImageToolbar, CK.ImageCaption, CK.ImageStyle, CK.ImageResize, CK.ImageInsert, CK.ImageUpload, CK.ImageTextAlternative,
        CK.Table, CK.TableToolbar,
        CK.SourceEditing, CK.Fullscreen, CK.PasteFromOffice,
        UploadPlugin,
      ],
      toolbar: {
        items: ["undo", "redo", "|", "heading", "|", "bold", "italic", "underline", "strikethrough", "removeFormat", "|", "bulletedList", "numberedList", "alignment", "|", "blockQuote", "insertTable", "|", "link", "insertImage", "horizontalLine", "|", "sourceEditing", "fullscreen"],
        shouldNotGroupWhenFull: true,
      },
      // The page already has one H1 (the title): the body starts at Heading 2.
      heading: {
        options: [
          { model: "paragraph", title: "Normal", class: "ck-heading_paragraph" },
          { model: "heading2", view: "h2", title: "Heading 2", class: "ck-heading_heading2" },
          { model: "heading3", view: "h3", title: "Heading 3", class: "ck-heading_heading3" },
          { model: "heading4", view: "h4", title: "Heading 4", class: "ck-heading_heading4" },
        ],
      },
      alignment: { options: ["left", "center", "right", "justify"] },
      image: { toolbar: ["imageStyle:block", "imageStyle:side", "|", "toggleImageCaption", "imageTextAlternative", "|", "resizeImage"] },
      table: { contentToolbar: ["tableColumn", "tableRow", "mergeTableCells"] },
      link: {
        defaultProtocol: "https://",
        decorators: { openInNewTab: { mode: "manual", label: "Open in a new tab", defaultValue: false, attributes: { target: "_blank", rel: "noopener noreferrer" } } },
      },
    })
      .then((editor) => {
        const sync = () => {
          field.value = editor.getData();
          // The live SEO score listens to this field.
          field.dispatchEvent(new Event("input", { bubbles: true }));
        };
        editor.model.document.on("change:data", sync);
        // A form can be submitted from Source mode: always take the latest HTML.
        field.form?.addEventListener("submit", () => {
          field.value = editor.getData();
        });
        window.articleEditor = editor;
        sync();
      })
      .catch((err) => {
        host.innerHTML = `<p class="err">The editor failed to start: ${String(err.message).slice(0, 160)}</p>`;
      });
  }
}
