// Starting configuration for the Media Library. setup() copies it into the admin
// sheet once; after that the sheet is the source of truth and this file is only
// used again for an empty sheet (and by the page's preview mode).
// Names follow the redefiners-asset-filing skill (2026-10-23). Use them exactly.

var OTHER = '__other__';
var NONE = '__none__'; // the "No sub-campaign" style choice of a step with a None Label: the step drops out of the path

// Step fields (all optional except id and label):
//   input: 'list' (default) or 'text'. A text step is a typed name. Its Options rows say for which
//          parent values it applies; the row's value is the field label, the row's Hint column (hints
//          here, by parent value) its help line.
//   allowNew: a list step that also accepts a typed new name (it is checked against the folders that
//          already exist, and added to Options when it is really new).
//   noneLabel: a list step that may be left out ("No sub-campaign (directly in the campaign)").
//   maxLength: limit for typed names (default 60). hint: help line under the field.
// Path tokens: any step id, {year}, {month} (from the date), {date} (YYYY-MM-DD).
// Step ids must not be year, month, date or type: those names are taken by the date and the
// photo/video file property.
// A folder made of several tokens ("{date} - {name}") is kept only when all of them have a value.

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
    },
    {
      id: 'events',
      label: 'Events',
      rootFolderProperty: 'EVENTS_ROOT_FOLDER_ID',
      path: '{kind}/{date} - {name}',
      contextFields: ['what', 'date', 'staff', 'notes'],
      optionalFields: [], // put 'what' here to make "What happened" optional
      dateLabel: 'Date of the event',
      active: true,
      steps: [
        { id: 'kind', label: 'Type of event', dependsOn: '' },
        { id: 'name', label: 'Event name', dependsOn: 'kind', input: 'text', maxLength: 60,
          hints: {
            Outreach: 'For example "Fall Festival at BGC Dover". Name the event, not the people in it.',
            Other: 'For example "Volunteer appreciation night". Name the event, not the people in it.'
          } }
      ],
      options: {
        kind: { '': ['Outreach', 'Other'] },
        name: { Outreach: ['Event name'], Other: ['Event name'] }
      }
    },
    {
      id: 'people',
      label: 'People',
      rootFolderProperty: 'PEOPLE_ROOT_FOLDER_ID',
      path: '{kind}/{date} - {name}',
      contextFields: ['what', 'date', 'staff', 'notes'],
      optionalFields: [],
      dateLabel: 'Date taken',
      active: true,
      steps: [
        { id: 'kind', label: 'Type', dependsOn: '' },
        { id: 'name', label: 'Name', dependsOn: 'kind', input: 'text', maxLength: 60,
          hints: { Headshot: 'Staff headshots only.', Moment: 'For example "Team game day" or "Volunteer testimonial".' } }
      ],
      options: {
        kind: { '': ['Headshot', 'Moment'] },
        name: { Headshot: ["Person's first and last name"], Moment: ['Name of the moment'] }
      }
    },
    {
      id: 'campaigns',
      label: 'Campaigns',
      rootFolderProperty: 'CAMPAIGNS_ROOT_FOLDER_ID',
      path: '{campaign}/{subcampaign}/{year}/{month}',
      contextFields: ['what', 'date', 'staff', 'notes'],
      optionalFields: [],
      dateLabel: 'Date the photos or videos were taken',
      active: true,
      steps: [
        { id: 'campaign', label: 'Campaign', dependsOn: '', allowNew: true, maxLength: 60 },
        { id: 'subcampaign', label: 'Sub-campaign', dependsOn: 'campaign', noneLabel: 'No sub-campaign (directly in the campaign)' }
      ],
      options: {
        // Property Tax Education and Coke Florida Partnership are left out of the picker on purpose
        // (Lucas Blanco, 2026-11-06). A typed name that matches them still goes into their folder.
        campaign: { '': ['Fundraising', 'MCP Enrollment', 'MyReDefiners Portal', 'Global Explorers', 'Summer STEAM', 'Contracted Services'] },
        // Subfolders that exist in Drive (read 2026-11-06). syncSubfolders() in Setup.gs adds new ones to the sheet.
        subcampaign: {
          'MCP Enrollment': ['Student Referral'],
          'MyReDefiners Portal': ['Email Content'],
          Fundraising: ['FY26-27 End Year Donations Campaign']
        }
      }
    }
  ]
};
