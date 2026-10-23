// Starting configuration for the Media Library. setup() copies it into the admin
// sheet once; after that the sheet is the source of truth and this file is only
// used again for an empty sheet (and by the page's preview mode).
// Names follow the redefiners-asset-filing skill (2026-10-23). Use them exactly.

var OTHER = '__other__';

var DEFAULTS = {
  collections: [
    {
      id: 'classes',
      label: 'Classes and Programs',
      // Drive folder: ReDefiners Media Library / Classes and Programs. The id is kept out of this
      // public file: setup() reads it from the script property named here.
      rootFolderProperty: 'CLASSES_ROOT_FOLDER_ID',
      // A step that does not apply (no sub course for most courses) drops out of the path.
      path: '{program}/{course}/{subcourse}/{site}/{year}/{month}',
      contextFields: ['what', 'date', 'staff', 'notes'],
      active: true,
      steps: [
        { id: 'program', label: 'Program', dependsOn: '', otherFolder: '', askNote: false },
        { id: 'course', label: 'Course', dependsOn: 'program', otherFolder: '', askNote: false },
        { id: 'subcourse', label: 'Sub course', dependsOn: 'course', otherFolder: 'Unknown Course', askNote: true },
        { id: 'site', label: 'Site', dependsOn: 'program', otherFolder: 'Site Unknown', askNote: true }
      ],
      // options[step][parent value] = list. '' = the step has no parent.
      options: {
        program: { '': ['MCP', 'GEP'] },
        course: {
          MCP: [
            "Let's Learn English", "Let's Learn Spanish", "Let's Learn Chinese", "Let's Learn Arabic",
            'Spanish Workshop for Adults', 'Chinese Workshop for Adults', 'Arabic Workshop for Adults',
            'ESOL',
            'Spanish for Professionals', 'Chinese for Professionals', 'Arabic for Professionals',
            'Spanish Youth Club', 'Arabic Youth Club', 'Chinese Youth Club',
            'English for School Success'
          ],
          GEP: ['Arabic', 'Spanish', 'Chinese']
        },
        subcourse: {
          ESOL: ['English for Daily Life', 'English for Family Life', 'English for Working Life', 'English for Life in the U.S.'],
          'English for School Success': ['English for School Success (9-13)', 'English for School Success (14-18)']
        },
        site: {
          // Source: https://redefinerswl.org/learn-in-florida (type first, CBFRC or BGC)
          MCP: [
            "CBFRC Town N' Country", 'CBFRC North Tampa', 'CBFRC Temple Terrace', 'ReDefiners Center',
            'CBFRC Central Tampa', 'CBFRC Brandon', 'CBFRC Plant City', 'CBFRC South County',
            "BGC Town N' Country", 'BGC Temple Terrace', 'BGC Plant City', 'BGC Belmont Heights',
            'BGC Dover', 'BGC Wimauma', 'BGC Riverview'
          ],
          // Source: the GEP program's cohorts in Salesforce, read 2026-10-23
          GEP: [
            'Broward Elementary', 'Edison Elementary', 'Emmanuel P. Johnson', 'Fair Oaks', 'Grant Park',
            'James Elementary', 'Kenly Elementary', 'Kenly Park', 'Lamb Elementary', 'Lockhart Elementary',
            'Lomax Elementary', 'Mendenhall Elementary', 'Palm River Elementary', 'Potter Elementary',
            'Riverview Elementary', 'Robles Elementary', 'Seminole Elementary', 'Sheehy Elementary'
          ]
        }
      }
    }
  ]
};
